#!/usr/bin/env bash
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
NAME="htp-remediation-test-$$"
IMAGE=${REMEDIATION_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}
trap 'podman rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
podman run -d --rm --network none --name "$NAME" --tmpfs /var/lib/postgresql/data:rw,size=1g -e POSTGRES_PASSWORD=fixture "$IMAGE" >/dev/null
psqlc() { podman exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U supabase_admin -d postgres "$@"; }
ready=false
for _ in $(seq 1 60); do if psqlc -Atc 'select 1' >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
$ready || { echo 'PostgreSQL did not start' >&2; exit 1; }
psqlc <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
SQL
for f in 20261028142440_create_websites.sql 20261031053344_seosmith_audits.sql 20261122000000_website_forms.sql 20261122000100_forms_acceptance.sql 20261122000200_forms_host_verification.sql 20261122000300_forms_management.sql 20261122000400_forms_notifications.sql 20261122000500_forms_response_deletion.sql 20261122000600_forms_rename_safety.sql 20261122000700_forms_ingress_gate.sql 20261122000800_forms_uncertain_retry.sql 20261122000900_forms_client_admission.sql 20261128000000_forms_host_challenge_quota.sql; do psqlc < "$ROOT/supabase/migrations/$f"; done
psqlc <<'SQL'
revoke execute on function public.begin_form_host_verification(uuid,text),public.form_host_challenge(uuid),public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]),public.set_website_form_response_status(uuid,uuid,uuid,text),public.request_form_recipient(uuid,uuid,text),public.disable_form_recipient(uuid,uuid,uuid),public.retry_form_delivery(uuid,uuid,uuid),public.delete_website_form_response(uuid,uuid,uuid) from public,anon,authenticated;
SQL
psqlc < "$ROOT/supabase/migrations/20261201000000_forms_pilot_scope.sql"
psqlc < "$ROOT/supabase/migrations/20261202000000_seosmith_remediation.sql"
psqlc < "$ROOT/supabase/tests/remediation-pg17/verify.sql"
