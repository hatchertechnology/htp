#!/usr/bin/env bash
# N-M3: time commit_seosmith_audit_v4 on S2's exact-cap schema-4 fixture (with evidence) with the DB
# container held to --cpus 0.2 (a stand-in for the 0.2-CPU record, not production hardware).
# The row insert (with its after-insert triggers) is timed as its own stage, rolled back, then the real
# RPC is timed end to end as service_role.   nm3.sh <db-container> <exact-cap.json> <workdir> <runs> <here>
set -uo pipefail
DB="$1"; CAP="$2"; WORK="$3"; RUNS="$4"; here="$5"
HTP_T="${HTP_TARGET_DIR:-/var/tmp/s4x-target-htp}"; ADMIT="$HTP_T/release/examples/admit"
LIMIT_MS=10000
adm() { podman exec -i "$DB" psql -U supabase_admin -d postgres -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
site=00000000-0000-4000-8000-000000000002
tok=tok-cap-0000000000000000000000000000
rev=s14-wire-1/full-population-1/evidence-v1
podman exec -u 0 "$DB" mkdir -p /tmp/s4 >/dev/null; podman exec -u 0 "$DB" chmod a+rwx /tmp/s4
for i in $(seq 1 "$RUNS"); do
  id="$(printf '00000000-0000-4000-8000-%012x' $((0xe000 + i)))"
  node "$here/prep.mjs" "$CAP" "$WORK/nm3-$i.json" --request "$id" || exit 1
  "$ADMIT" "$WORK/nm3-$i.json" >"$WORK/nm3-$i.sum" 2>"$WORK/nm3-$i.err" || { cat "$WORK/nm3-$i.err"; echo "admit failed"; exit 1; }
  podman cp "$WORK/nm3-$i.json" "$DB:/tmp/s4/r$i.json"; podman cp "$WORK/nm3-$i.sum" "$DB:/tmp/s4/s$i.json"
done
podman exec -u 0 "$DB" chmod -R a+r /tmp/s4
trig="$(adm -c "select tgenabled from pg_trigger where tgrelid='public.seosmith_audits'::regclass and tgname='seosmith_lifecycle_index_after_insert'")"
[[ "$trig" == O ]] || { echo "lifecycle trigger not enabled ($trig)"; exit 1; }
adm -c "update public.audit_event_config set enqueue_enabled=true" >/dev/null
adm >/dev/null <<SQL
drop schema if exists bench cascade; create schema bench; create table bench.results(run int, stage text, ms numeric);
SQL
if podman update --cpus 0.2 "$DB" >/dev/null 2>&1; then
  echo "throttle: podman update --cpus 0.2 ok; NanoCpus=$(podman inspect "$DB" --format '{{.HostConfig.NanoCpus}}')"
else
  echo "throttle: podman update FAILED"; exit 2
fi
trap 'podman update --cpus 0 "$DB" >/dev/null 2>&1' EXIT
cg="$(podman inspect "$DB" --format '{{.State.CgroupPath}}' 2>/dev/null)"
cpumax="$(cat "/sys/fs/cgroup$cg/cpu.max" 2>/dev/null || true)"; echo "cgroup cpu.max=${cpumax:-unreadable}"
for i in $(seq 1 "$RUNS"); do
  id="$(printf '00000000-0000-4000-8000-%012x' $((0xe000 + i)))"
  adm >/dev/null <<SQL || { echo "run $i failed"; exit 1; }
select pg_read_file('/tmp/s4/r$i.json') as raw, pg_read_file('/tmp/s4/s$i.json') as summary \gset
select encode(sha256(convert_to(:'raw','UTF8')),'hex') as sha \gset
create temp table p as select :'raw'::text as raw, :'sha'::text as sha, :'summary'::text as summary;
do \$\$ declare t timestamptz; r jsonb; raw text; sm text; sh text; compact jsonb; ms numeric; ins numeric;
begin
  select p.raw,p.summary,p.sha into raw,sm,sh from pg_temp.p p;
  t:=clock_timestamp(); perform encode(sha256(convert_to(raw,'UTF8')),'hex');
  insert into bench.results values ($i,'raw sha256',extract(epoch from clock_timestamp()-t)*1000);
  t:=clock_timestamp(); r:=raw::jsonb;
  insert into bench.results values ($i,'raw::jsonb parse',extract(epoch from clock_timestamp()-t)*1000);
  t:=clock_timestamp(); perform r is distinct from raw::jsonb;
  insert into bench.results values ($i,'raw/report equality (re-parse + compare)',extract(epoch from clock_timestamp()-t)*1000);
  t:=clock_timestamp();
  select jsonb_set(jsonb_object_agg(k, r->k),'{schema_version}','2'::jsonb) into compact from unnest(array['schema_version','pages','findings','request','outcome','started_at','finished_at','engine_version','ruleset_version','stop_reason','coverage_complete','evidence_contract']) k where r ? k;
  perform public.seosmith_validate_evidence(compact);
  insert into bench.results values ($i,'evidence validation',extract(epoch from clock_timestamp()-t)*1000);
  -- the row insert alone (all triggers fire); rolled back by the marker exception
  begin
    t:=clock_timestamp();
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source,summary_text,summary_sha256,validator_revision)
      values ('$id','$site','example.com',1,sh,r,raw,'worker',sm,encode(sha256(convert_to(sm,'UTF8')),'hex'),'$rev');
    ins:=extract(epoch from clock_timestamp()-t)*1000;
    raise exception 'rollback_marker';
  exception when raise_exception then
    if sqlerrm <> 'rollback_marker' then raise; end if;
  end;
  insert into bench.results values ($i,'INSERT alone (row + after-insert triggers incl. lifecycle index)',ins);
end \$\$;
grant usage on schema bench to service_role; grant all on bench.results to service_role; grant select on pg_temp.p to service_role;
set role service_role;
do \$\$ declare t timestamptz; p record; begin
  select * into p from pg_temp.p;
  t:=clock_timestamp();
  perform public.commit_seosmith_audit_v4('$tok','$id',p.sha,p.raw,p.summary,'$rev');
  insert into bench.results values ($i,'COMMIT total (RPC)',extract(epoch from clock_timestamp()-t)*1000);
end \$\$;
reset role;
SQL
done
echo "container limits: NanoCpus=$(podman inspect "$DB" --format '{{.HostConfig.NanoCpus}}'); cpu.stat: $(tr '\n' ' ' <"/sys/fs/cgroup$cg/cpu.stat" 2>/dev/null | cut -c1-200)"
printf '%-72s %10s %10s %10s\n' stage p50_ms max_ms runs
adm -F'|' -c "select stage, round((percentile_cont(0.5) within group (order by ms))::numeric,1), round(max(ms),1), count(*) from bench.results group by stage order by min(case when stage like 'raw sha%' then 1 when stage like 'raw::%' then 2 when stage like 'raw/%' then 3 when stage like 'evidence%' then 4 when stage like 'INSERT%' then 5 else 6 end)" | awk -F'|' '{printf "%-72s %10s %10s %10s\n",$1,$2,$3,$4}'
p50="$(adm -c "select round((percentile_cont(0.5) within group (order by ms))::numeric) from bench.results where stage='COMMIT total (RPC)'")"
max_ms="$(adm -c "select round(max(ms)) from bench.results where stage='COMMIT total (RPC)'")"
ins_max="$(adm -c "select round(max(ms)) from bench.results where stage like 'INSERT%'")"
echo "COMMIT max ${max_ms} ms p50 ${p50} ms over $RUNS runs at --cpus 0.2 (limit ${LIMIT_MS} ms); insert alone max ${ins_max} ms; loadavg $(cut -d' ' -f1-3 /proc/loadavg)"
(( max_ms <= LIMIT_MS ))
