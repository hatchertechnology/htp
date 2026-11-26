#!/usr/bin/env bash
# WP4 audit-event runner on real PG17 (supabase/postgres image, no network, always removed):
# production-order migrations, real multi-session concurrency, snapshot-lock blocking/release,
# lock_timeout retry, and a real pg_cron tick. Needs only podman and the image; no H1 checkout.
#   scripts/audit-event-runner-pg17/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD"
MIG_DIR="${S14_MIGRATIONS_DIR:-$root/supabase/migrations}"
PG_IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}"
FIRST_NEW="20261211000000"
PENDING=(20261202000000_seosmith_remediation.sql 20261203000000_audit_event_queue.sql 20261203000001_audit_operational_hooks.sql 20261204000000_search_bounded_dataset.sql 20261205000000_comparison_pilot_scope.sql)
pg="audit-runner-pg17-$$"
tmp="$(mktemp -d "${TMPDIR:-/var/tmp}/audit-runner-pg17.XXXXXXXX")"
cleanup() { local rc=$?; trap - EXIT; jobs -p | xargs -r kill 2>/dev/null || true; podman rm -f --volumes "$pg" >/dev/null 2>&1 || true; rm -rf "$tmp"; exit "$rc"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mapfile -t all < <(cd "$MIG_DIR" && ls *.sql | sort)
base=(); new=(); pend=()
for f in "${all[@]}"; do
  v="${f%%_*}"
  if [[ "$v" > "$FIRST_NEW" || "$v" == "$FIRST_NEW" ]]; then new+=("$f")
  elif printf '%s\n' "${PENDING[@]}" | grep -qx "$f"; then pend+=("$f")
  else base+=("$f"); fi
done
seq=("${base[@]}" "${pend[@]}" "${new[@]}")
echo "== production order: ${#seq[@]} migrations (head $(git rev-parse --short HEAD))"

podman run --pull=never -d --name "$pg" --network none -e POSTGRES_PASSWORD=fixture-only "$PG_IMAGE" postgres -D /var/lib/postgresql/data -c shared_preload_libraries=pg_cron -c cron.database_name=postgres >/dev/null
ok=false
for _ in $(seq 1 120); do podman logs "$pg" 2>&1 | grep -q 'PostgreSQL init process complete' && { ok=true; break; }; sleep 1; done
[[ "$ok" == true ]] || { podman logs "$pg" >&2; exit 1; }
for _ in $(seq 1 60); do podman exec "$pg" psql -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
adm() { podman exec -i "$pg" psql -U supabase_admin -d postgres -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
mig() { podman exec -i "$pg" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1; }
svc() { adm -c "set role service_role" -c "$1"; } # one statement as service_role (call must be last)
adm >/dev/null <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(),auth.uid() to public;
SQL
for f in "${seq[@]}"; do mig <"$MIG_DIR/$f" >"$tmp/m.out" 2>&1 || { echo "MIGRATION FAILED: $f" >&2; cat "$tmp/m.out" >&2; exit 1; }; done
echo "applied ${#seq[@]} migrations incl. 20261214000000_audit_event_runner"

# Seeding. Only the enqueue trigger stays live; the schema-validation and index triggers are
# disabled so synthetic receipts and their indexed evaluations can be inserted directly.
adm >/dev/null <<'SQL'
do $$ declare t record; begin
  for t in select tgname from pg_trigger where tgrelid='public.seosmith_audits'::regclass and not tgisinternal and tgname<>'audit_enqueue_receipt' loop
    execute format('alter table public.seosmith_audits disable trigger %I', t.tgname); end loop; end $$;
insert into auth.users(id) values ('00000000-0000-4000-8000-0000000000aa') on conflict do nothing;
create schema t; grant usage on schema t to service_role;
create table t.runs(pid int, delivery_id uuid); grant all on t.runs to service_role;
create function t.log_run() returns trigger language plpgsql security definer as $$begin insert into t.runs values(pg_backend_pid(),new.delivery_id); return new; end$$;
create trigger log_run after update on public.audit_event_jobs for each row when (new.state='processed' and old.state='leased') execute function t.log_run();
-- seed(site_n, receipts, fail_from): site site_n gets receipts 1..N, one per day, pass until fail_from then fail.
create function t.seed(site_n int, n int, fail_from int) returns void language plpgsql as $$
declare site uuid := ('00000000-0000-4000-8000-'||lpad(site_n::text,12,'0'))::uuid; d uuid; i int; o text;
begin
  insert into public.websites(id,owner_id,fqdn) values (site,'00000000-0000-4000-8000-0000000000aa','s'||site_n||'.example') on conflict do nothing;
  for i in 1..n loop
    d := ('00000001-0000-4000-8000-'||lpad(site_n::text,6,'0')||lpad(i::text,6,'0'))::uuid;
    o := case when i>=fail_from then 'fail' else 'pass' end;
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,scan_at,summary)
      values (d,site,'s'||site_n||'.example',1,repeat('a',64),
        jsonb_build_object('schema_version','1','findings',case when o='fail' then '[{"key":"f","severity":"warning"}]'::jsonb else '[]'::jsonb end),
        timestamptz '2026-01-01' + i*interval '1 day','{"schema_version":"2"}'::jsonb);
    insert into public.seosmith_lifecycle_indexed(delivery_id,state,evidence_truncated,policy_digest,comparison_key,engine_version,ruleset_version) values (d,'indexed_v1',false,'p','k','e','r');
    insert into public.seosmith_lifecycle_evaluations(delivery_id,entity_id,rule,evaluation) values (d,'ent','rule',
      jsonb_build_object('eligibility','eligible','attempt','completed','outcome',o,'rule_version','1','validator_version','1','source_locator','/e/0','finding_key',case when o='fail' then 'f' end));
  end loop;
end $$;
SQL
q() { adm -c "$1"; }
reset_queue() { q "delete from public.audit_events; delete from public.audit_event_jobs; delete from public.seosmith_audits; update public.audit_event_config set enqueue_enabled=false,processing_enabled=false; truncate t.runs" >/dev/null; }

echo "== concurrency: two real sessions call the procedure over 8 bindings x 12 receipts"
q "update public.audit_event_config set enqueue_enabled=true" >/dev/null
for s in 1 2 3 4 5 6 7 8; do q "select t.seed($s,12,7)" >/dev/null; done
[[ "$(q 'select count(*) from public.audit_event_jobs')" == 96 ]] || fail "expected 96 queued jobs"
q "update public.audit_event_config set processing_enabled=true" >/dev/null
adm -c "set role service_role" -c "call public.audit_event_run(500)" >"$tmp/c1.out" 2>&1 & p1=$!
adm -c "set role service_role" -c "call public.audit_event_run(500)" >"$tmp/c2.out" 2>&1 & p2=$!
wait "$p1" || { cat "$tmp/c1.out"; fail "runner 1"; }; wait "$p2" || { cat "$tmp/c2.out"; fail "runner 2"; }
[[ "$(q "select count(*) from public.audit_event_jobs where state='processed'")" == 88 ]] || fail "processed != 88: $(q 'select state,hold_reason,count(*) from public.audit_event_jobs group by 1,2')"
[[ "$(q "select count(*) from public.audit_event_jobs where state='held' and hold_reason='history_unknown'")" == 8 ]] || fail "expected 8 baseline-less holds"
[[ "$(q "select count(*) from public.audit_event_jobs where state in ('pending','leased')")" == 0 ]] || fail "unfinished jobs"
[[ "$(q "select count(*) from t.runs")" == "$(q "select count(distinct delivery_id) from t.runs")" ]] || fail "a job was processed twice"
# per binding: pass x6 then fail from receipt 7 -> exactly one 'new' event at receipt 7 (fail->fail emits nothing)
[[ "$(q "select count(*) from public.audit_events where kind='new'")" == 8 ]] || fail "expected 8 new events"
echo "ok: all jobs drained, none twice, 8 events, runner pids that processed jobs: $(q 'select count(distinct pid) from t.runs')"

echo "== snapshot lock blocks receipt inserts during processing and is released after; a failed job releases it too"
reset_queue
q "update public.audit_event_config set enqueue_enabled=true" >/dev/null
q "select t.seed(11,3,3)" >/dev/null
q "update public.audit_event_jobs set state='processed' where delivery_id in (select delivery_id from public.seosmith_audits where scan_at<'2026-01-04')" >/dev/null
q "create or replace function t.slow() returns trigger language plpgsql as \$\$begin perform pg_sleep(4); return new; end\$\$;
   create trigger slow before insert on public.audit_events for each row execute function t.slow()" >/dev/null
q "update public.audit_event_config set processing_enabled=true" >/dev/null
adm -c "set role service_role" -c "call public.audit_event_run(5)" >"$tmp/s.out" 2>&1 & p=$!
sleep 1.5
t0=$(date +%s.%N)
q "select t.seed(12,1,9)" >/dev/null      # a receipt insert on another binding needs ROW EXCLUSIVE vs the runner's SHARE
t1=$(date +%s.%N)
wait "$p" || { cat "$tmp/s.out"; fail "runner"; }
blocked=$(echo "$t1 - $t0" | bc)
echo "receipt insert waited ${blocked}s while the runner held the snapshot lock"
(( $(echo "$blocked > 1.5" | bc) )) || fail "insert was not blocked by the snapshot lock ($blocked s)"
[[ "$(q "select state from public.audit_event_jobs where delivery_id='00000001-0000-4000-8000-000011000003'")" == processed ]] || fail "job not processed"
q "drop trigger slow on public.audit_events" >/dev/null
# failed job: the lock must be released by the savepoint, so an insert right after is immediate
q "update public.audit_event_jobs set state='pending' where delivery_id='00000001-0000-4000-8000-000011000003'; delete from public.audit_events" >/dev/null
q "create or replace function t.boom() returns trigger language plpgsql as \$\$begin raise exception 'boom'; end\$\$;
   create trigger boom before insert on public.audit_events for each row execute function t.boom()" >/dev/null
adm -c "set role service_role" -c "call public.audit_event_run(5)" >"$tmp/s2.out" 2>&1 || { cat "$tmp/s2.out"; fail "runner after poison"; }
[[ "$(q "select hold_reason from public.audit_event_jobs where delivery_id='00000001-0000-4000-8000-000011000003'")" == processor_unavailable ]] || fail "poison not held"
[[ "$(q "select count(*) from pg_locks where mode='ShareLock' and relation='public.seosmith_audits'::regclass")" == 0 ]] || fail "share lock still held after the run"
t0=$(date +%s.%N); q "select t.seed(13,1,9)" >/dev/null; t1=$(date +%s.%N)
(( $(echo "$t1 - $t0 < 1.0" | bc) )) || fail "insert after a failed job was slow"
q "drop trigger boom on public.audit_events" >/dev/null
echo "ok: blocked ${blocked}s while held, immediate after release, poison held"

echo "== lock_timeout: a conflicting writer holds the table; the job stays pending and is retried"
reset_queue
q "update public.audit_event_config set enqueue_enabled=true" >/dev/null
q "select t.seed(21,3,3)" >/dev/null
q "update public.audit_event_jobs set state='processed' where delivery_id in (select delivery_id from public.seosmith_audits where scan_at<'2026-01-04')" >/dev/null
q "update public.audit_event_config set processing_enabled=true" >/dev/null
adm -c "begin; lock table public.seosmith_audits in row exclusive mode; select pg_sleep(14); commit" >/dev/null 2>&1 & holder=$!
sleep 1.5
t0=$(date +%s.%N); adm -c "set role service_role" -c "call public.audit_event_run(5)" >"$tmp/l.out" 2>&1 || { cat "$tmp/l.out"; fail "runner must not raise on a lock timeout"; }; t1=$(date +%s.%N)
el=$(echo "$t1 - $t0" | bc); echo "runner returned after ${el}s"
(( $(echo "$el > 4 && $el < 10" | bc) )) || fail "expected a ~5s lock timeout, took $el"
[[ "$(q "select state||'/'||(select attempts||'/'||last_sqlstate from public.audit_event_job_attempts) from public.audit_event_jobs where delivery_id='00000001-0000-4000-8000-000021000003'")" == "pending/1/55P03" ]] || fail "job not pending with 1 attempt"
wait "$holder" || true
adm -c "set role service_role" -c "call public.audit_event_run(5)" >/dev/null || fail "retry run"
[[ "$(q "select state from public.audit_event_jobs where delivery_id='00000001-0000-4000-8000-000021000003'")" == processed ]] || fail "retry did not process"
[[ "$(q "select count(*) from public.audit_events")" == 1 ]] || fail "expected the retried job to emit its event"

echo "== a real pg_cron tick runs the procedure"
reset_queue
q "update public.audit_event_config set enqueue_enabled=true" >/dev/null
q "select t.seed(31,3,3)" >/dev/null
q "update public.audit_event_config set processing_enabled=true" >/dev/null
if ! adm -c "create extension if not exists pg_cron" >"$tmp/cron.out" 2>&1; then cat "$tmp/cron.out"; fail "pg_cron unavailable in this image"; fi
podman cp "$root/supabase/cron/audit-events.sql" "$pg:/tmp/audit-events.sql"
adm -f /tmp/audit-events.sql >/dev/null
[[ "$(q "select schedule||' '||command from cron.job where jobname='htp-audit-events'")" == "* * * * * call public.audit_event_run(50);" ]] || fail "schedule not installed"
done_=false
for _ in $(seq 1 90); do
  [[ "$(q "select count(*) from public.audit_event_jobs where state<>'pending'")" == 3 ]] && { done_=true; break; }; sleep 2
done
[[ "$done_" == true ]] || { q "select status,return_message from cron.job_run_details order by runid"; fail "cron tick did not drain the queue"; }
[[ "$(q "select status||' '||return_message from cron.job_run_details order by runid limit 1")" == "succeeded CALL" ]] || fail "cron run not succeeded: $(q 'select status,return_message from cron.job_run_details')"
[[ "$(q "select count(*) from public.audit_events where kind='new'")" == 1 ]] || fail "cron tick did not emit the event"
podman cp "$root/supabase/rollbacks/20261214000000_audit_event_runner_unschedule.sql" "$pg:/tmp/unsched.sql"
adm -f /tmp/unsched.sql >/dev/null
[[ "$(q "select count(*) from cron.job where jobname='htp-audit-events'")" == 0 ]] || fail "unschedule left the job"
echo "AUDIT-EVENT-RUNNER-PG17: PASS"
