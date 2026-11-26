#!/usr/bin/env bash
# Q9 purge semantics: before Step 4b the remaining schema-2 rows of a website are deleted. Since 46-48 the
# audit table has RESTRICT references (verification attempts, comparisons), so a bare delete fails when work
# has been recorded against a schema-2 audit; the purge must delete those dependents first.
#   q9.sh <db-container> <workdir> <here>
set -uo pipefail
DB="$1"; WORK="$2"; here="$3"
q() { podman exec -i "$DB" psql -U postgres -d postgres -X -q -tA -v ON_ERROR_STOP=1 -c "$1"; }
MIX=22222222-2222-4222-8222-222222222222
ids="$(q "select delivery_id from public.seosmith_audits where website_id='$MIX' and report->>'schema_version' in ('1','2')")"
[[ -n "$ids" ]] || { echo "no schema-1/2 rows to purge"; exit 1; }
s2="$(head -1 <<<"$ids")"
n4="$(q "select count(*) from public.seosmith_audits where website_id='$MIX' and report->>'schema_version'='4'")"
before="$(q "select count(*) from public.seosmith_audits where website_id='$MIX'")"
# work recorded against the schema-2 audit (remediation + a verification attempt that RESTRICTs the audit row)
q "insert into public.seosmith_remediation(website_id,delivery_id,finding_index,finding_key,status) values ('$MIX','$s2',0,'k','open')" >/dev/null
q "insert into public.seosmith_verification_attempts(remediation_id,delivery_id,result,note) select id,'$s2','unverified','q9' from public.seosmith_remediation where delivery_id='$s2'" >/dev/null
derived_before="$(q "select (select count(*) from public.seosmith_lifecycle_indexed where delivery_id='$s2')||'/'||(select count(*) from public.seosmith_lifecycle_evaluations where delivery_id='$s2')||'/'||(select count(*) from public.audit_event_jobs where delivery_id='$s2')")"
if q "delete from public.seosmith_audits where delivery_id='$s2'" >/dev/null 2>"$WORK/q9.err"; then echo "bare delete unexpectedly succeeded"; exit 1; fi
err="$(tr '\n' ' ' <"$WORK/q9.err" | cut -c1-200)"
grep -qiE 'foreign key|violates' <<<"$err" || { echo "unexpected error: $err"; exit 1; }
echo "Q9 bare delete of a schema-2 audit with a verification attempt FAILS (restrict): $err"
# the reviewed ordered purge, in one transaction, guarded by website, schema and source
purged="$(q "select count(*) from public.seosmith_audits where website_id='$MIX' and report->>'schema_version' in ('1','2')")"
podman exec -i "$DB" psql -U postgres -d postgres -X -q -tA -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "ordered purge failed"; exit 1; }
begin;
create temp table doomed on commit drop as select delivery_id from public.seosmith_audits
  where website_id='$MIX' and report->>'schema_version' in ('1','2') and ingestion_source in ('worker','import');
delete from public.seosmith_verification_attempts where delivery_id in (select delivery_id from doomed);
delete from public.independent_audit_comparisons where delivery_id in (select delivery_id from doomed);
delete from public.seosmith_audits where delivery_id in (select delivery_id from doomed);
commit;
SQL
after="$(q "select count(*) from public.seosmith_audits where website_id='$MIX'")"
left2="$(q "select count(*) from public.seosmith_audits where website_id='$MIX' and report->>'schema_version' in ('1','2')")"
n4after="$(q "select count(*) from public.seosmith_audits where website_id='$MIX' and report->>'schema_version'='4'")"
orph="$(q "select (select count(*) from public.seosmith_lifecycle_indexed where delivery_id='$s2')+(select count(*) from public.seosmith_lifecycle_evaluations where delivery_id='$s2')+(select count(*) from public.seosmith_remediation where delivery_id='$s2')+(select count(*) from public.audit_event_jobs where delivery_id='$s2')+(select count(*) from public.seosmith_summary_cache where delivery_id='$s2')")"
echo "Q9 ordered purge: candidates=$purged rows $before -> $after; schema-1/2 left=$left2; schema-4 before/after=$n4/$n4after; derived rows (lifecycle idx/evals/jobs) of the purged audit before=$derived_before, orphans after=$orph"
[[ "$left2" == 0 && "$n4" == "$n4after" && "$orph" == 0 ]]
