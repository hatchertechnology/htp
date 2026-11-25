#!/usr/bin/env python3
"""Print a reviewable, atomic one-migration ledger45 candidate. No network/I/O to DB.

Use only after independent review and reconciliation of the actual hosted baseline.
This guards migration versions, not the full hosted catalog or release holds.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
VERSION = '20261206000000'
NAME = 'provider_consent_fence'
source = (ROOT / 'supabase/migrations' / f'{VERSION}_{NAME}.sql').read_text()
assert source.count('\nbegin;\n') == 1 and source.endswith('commit;\n')
body = source.replace('\nbegin;\n', '\n', 1).removesuffix('commit;\n')
versions = sorted(p.name.split('_')[0] for p in (ROOT / 'supabase/migrations').glob('*.sql') if p.name <= '20261201000000_forms_pilot_scope.sql')
assert len(versions) == 45 and len(set(versions)) == 45
expected = 'array[' + ','.join("'%s'" % v for v in versions) + ']::text[]'
assert '$consent_source$' not in body
rollback = sys.argv[1:] == ['--rollback']
if sys.argv[1:] and not rollback:
    raise SystemExit('Usage: provider-consent-fence-ledger45.py [--rollback]')
if rollback:
    source_rollback = (ROOT / 'supabase/rollbacks' / f'{VERSION}_{NAME}.sql').read_text()
    assert source_rollback.count('\nbegin;\n') == 1 and source_rollback.endswith('commit;\n')
    rollback_body = source_rollback.replace('\nbegin;\n','\n',1).removesuffix('commit;\n')
    expected_after = 'array[' + ','.join("'%s'" % v for v in sorted(versions + [VERSION])) + ']::text[]'
    print(f"""-- Hold native rollout; drain/restart pending consent before rollback.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $guard$
begin
  if (select array_agg(version::text order by version) from supabase_migrations.schema_migrations)
      is distinct from {expected_after} or not exists (
      select 1 from supabase_migrations.schema_migrations where version='{VERSION}'
      and name='{NAME}' and statements=array[$consent_source${body}$consent_source$]) then
    raise exception 'consent_ledger46_rollback_drift';
  end if;
end $guard$;
{rollback_body}
delete from supabase_migrations.schema_migrations where version='{VERSION}';
commit;
""", end='')
    raise SystemExit(0)
print(f"""-- GENERATED from the committed consent migration; no other migration is applied.
-- HOLD: separately review hosted catalogs, effective ACLs and existing ledger45 guards.
-- Ledger statements stores the exact multi-statement migration body as one text item.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $guard$
begin
  if (select array_agg(version::text order by version) from supabase_migrations.schema_migrations)
      is distinct from {expected} then
    raise exception 'consent_ledger45_version_drift';
  end if;
end $guard$;
{body}
insert into supabase_migrations.schema_migrations(version,name,statements)
values('{VERSION}','{NAME}',array[$consent_source${body}$consent_source$]);
commit;
""", end='')
