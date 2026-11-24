import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

// Held default: the seven comparison RPCs stay revoked from PUBLIC/anon/
// authenticated. The pilot migration must not grant any of them.
const held = [
  'import_independent_audit(uuid,text,text,jsonb)',
  'independent_audit_history(uuid,uuid,timestamptz,uuid)',
  'save_independent_comparison(uuid,uuid,uuid,boolean)',
  'independent_comparison_history(uuid,timestamptz,uuid)',
  'independent_comparison_detail(uuid,uuid)',
  'independent_evidence_fingerprint(uuid)',
  'delete_independent_audit_evidence(uuid,text,text)',
]
const cleanup = 'delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)'
const source = 'url,rule,state\r\nhttps://example.com/,missing_title,present\r\n'

test('comparison pilot gate is default-empty, owner/site scoped and bounded', async () => {
  const db = new PGlite()
  const owner = '00000000-0000-0000-0000-000000000001'
  const other = '00000000-0000-0000-0000-000000000002'
  const site = '00000000-0000-0000-0000-000000000003'
  const site2 = '00000000-0000-0000-0000-000000000004'
  const delivery = '00000000-0000-0000-0000-000000000008'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql', '20261031053344_seosmith_audits.sql', '20261124000000_independent_audit_comparisons.sql']) await db.exec(await read(`../migrations/${file}`))
    // Model the held public ACLs the pilot must preserve.
    for (const name of held) await db.exec(`revoke execute on function public.${name} from public,anon,authenticated`)
    const pilot = await read('../migrations/20261205000000_comparison_pilot_scope.sql')
    // The guard refuses a drifted function body before installing anything.
    await db.exec("alter function public.independent_audit_history(uuid,uuid,timestamptz,uuid) set search_path=public")
    await assert.rejects(() => db.exec(pilot), /comparison_pilot_function_drift/)
    await db.exec('rollback')
    assert.equal((await db.query("select to_regclass('public.comparison_pilot_approved_sites') name")).rows[0].name, null)
    await db.exec("alter function public.independent_audit_history(uuid,uuid,timestamptz,uuid) set search_path=''")
    // The guard refuses a table grant inherited through another role.
    await db.exec('create role pilot_inherited; grant pilot_inherited to service_role with inherit false, set true; alter default privileges in schema public grant all on tables to service_role; alter default privileges in schema public grant insert on tables to pilot_inherited')
    await assert.rejects(() => db.exec(pilot), /comparison_pilot_approval_privilege_drift/)
    await db.exec('rollback')
    assert.equal((await db.query("select to_regclass('public.comparison_pilot_approved_sites') name")).rows[0].name, null)
    await db.exec('alter default privileges in schema public revoke insert on tables from pilot_inherited; alter default privileges in schema public revoke all on tables from service_role')
    await db.exec(pilot)
    // Default empty and admin only.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) assert.equal((await db.query("select has_table_privilege($1,'public.comparison_pilot_approved_sites',$2) allowed", [role, privilege])).rows[0].allowed, false)
      for (const column of ['website_id', 'owner_id']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) assert.equal((await db.query("select has_column_privilege($1,'public.comparison_pilot_approved_sites',$2,$3) allowed", [role, column, privilege])).rows[0].allowed, false)
      assert.equal((await db.query("select has_function_privilege($1,'public.comparison_pilot_site_allowed(uuid)','execute') allowed", [role])).rows[0].allowed, false)
    }
    await db.exec('set role service_role')
    await assert.rejects(() => db.query('insert into public.comparison_pilot_approved_sites values($1,$2)', [site, owner]), /permission denied/)
    await assert.rejects(() => db.query('select public.comparison_pilot_site_allowed($1)', [site]), /permission denied/)
    await db.exec('reset role')
    for (const name of held) for (const role of ['anon', 'authenticated']) assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed', [role, `public.${name}`, 'execute'])).rows[0].allowed, false)
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await db.query("select has_function_privilege($1,'public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)','execute') allowed", [role])).rows[0].allowed, false)
    // Seed synthetic evidence.
    await db.query('insert into auth.users values($1),($2)', [owner, other])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com'),($3,$2,'other.example.com')", [site, owner, site2])
    await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,repeat('a',64),'{}')", [delivery, site])
    const identity = async (id, anonymous = false) => { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id, is_anonymous: anonymous })]) }
    // No approval: every owner call is denied, including a nonowner and an anonymous session.
    const named = {
      import: () => db.query('select public.import_independent_audit($1,$2,$3,$4)', [site, 'controlled-csv-v1', source, {}]),
      auditHistory: () => db.query('select public.independent_audit_history($1,$2)', [site, null]),
      save: () => db.query('select public.save_independent_comparison($1,$2,$3,true)', [site, '00000000-0000-0000-0000-0000000000aa', delivery]),
      comparisonHistory: () => db.query('select public.independent_comparison_history($1)', [site]),
      comparisonDetail: () => db.query('select public.independent_comparison_detail($1,$2)', [site, '00000000-0000-0000-0000-0000000000aa']),
      fingerprint: () => db.query('select public.independent_evidence_fingerprint($1)', [site]),
      delete: () => db.query("select public.delete_independent_audit_evidence($1,'DELETE INDEPENDENT EVIDENCE','x')", [site]),
    }
    for (const name of held) await db.exec(`grant execute on function public.${name} to authenticated`)
    await db.exec(`grant execute on function public.${cleanup} to authenticated`)
    await identity(other)
    for (const call of Object.values(named)) await assert.rejects(call, /forbidden/)
    await identity(owner, true)
    for (const call of Object.values(named)) await assert.rejects(call, /forbidden/)
    await identity(owner)
    for (const call of Object.values(named)) await assert.rejects(call, /forbidden/)
    // Approve the pair; the owner can now use every RPC.
    await db.exec('reset role')
    await db.query('insert into public.comparison_pilot_approved_sites values($1,$2)', [site, owner])
    await identity(owner)
    const receipt = (await named.import()).rows[0].import_independent_audit
    assert.equal((await named.auditHistory()).rows[0].independent_audit_history.items.length, 1)
    const comparison = (await db.query('select public.save_independent_comparison($1,$2,$3,true) c', [site, receipt.id, delivery])).rows[0].c
    assert.equal((await named.comparisonHistory()).rows[0].independent_comparison_history.items.length, 1)
    assert.equal((await db.query('select public.independent_comparison_detail($1,$2) d', [site, comparison.id])).rows[0].d.comparison.id, comparison.id)
    const fingerprint = (await named.fingerprint()).rows[0].independent_evidence_fingerprint
    // Bounded cleanup refuses a mismatch and preserves every row.
    await assert.rejects(() => db.query('select public.delete_comparison_pilot_evidence($1,$2,$3,$4)', [site, [], [comparison.id], fingerprint]), /evidence_scope_mismatch/)
    await assert.rejects(() => db.query('select public.delete_comparison_pilot_evidence($1,$2,$3,$4)', [site, [receipt.id, other], [comparison.id], fingerprint]), /evidence_scope_mismatch/)
    await assert.rejects(() => db.query('select public.delete_comparison_pilot_evidence($1,$2,$3,$4)', [site, [receipt.id], [comparison.id], 'wrong']), /evidence_changed_export_again/)
    await assert.rejects(() => db.query('select public.delete_comparison_pilot_evidence($1,$2,$3,$4)', [site, [receipt.id, receipt.id], [comparison.id], fingerprint]), /invalid_scope/)
    await db.exec('reset role')
    assert.equal((await db.query('select count(*)::int n from public.independent_audit_imports where website_id=$1', [site])).rows[0].n, 1)
    assert.equal((await db.query('select count(*)::int n from public.independent_audit_comparisons where website_id=$1', [site])).rows[0].n, 1)
    await identity(owner)
    const removed = (await db.query('select public.delete_comparison_pilot_evidence($1,$2,$3,$4) d', [site, [receipt.id], [comparison.id], fingerprint])).rows[0].d
    assert.equal(removed.imports_deleted, 1)
    assert.equal(removed.comparisons_deleted, 1)
    assert.equal((await db.query('select public.independent_evidence_fingerprint($1) f', [site])).rows[0].f, (await db.query("select encode(sha256(convert_to('','UTF8')),'hex') f")).rows[0].f)
    // Approval removal and ownership transfer invalidate the gate; re-adding restores it.
    await db.exec('reset role')
    await db.query('insert into public.independent_audit_imports(website_id,fqdn,format,source_text,source_sha256,metadata) values($1,$2,$3,$4,$5,$6)', [site, 'example.com', 'controlled-csv-v1', source, 'a'.repeat(64), {}])
    await identity(owner)
    assert.equal((await named.auditHistory()).rows[0].independent_audit_history.items.length, 1)
    await db.exec('reset role')
    await db.query('delete from public.comparison_pilot_approved_sites where website_id=$1', [site])
    await identity(owner)
    await assert.rejects(named.auditHistory, /forbidden/)
    await db.exec('reset role')
    await db.query('insert into public.comparison_pilot_approved_sites values($1,$2)', [site, owner])
    await db.query('update public.websites set owner_id=$1 where id=$2', [other, site])
    await identity(owner)
    await assert.rejects(named.auditHistory, /forbidden/)
    await identity(other)
    await assert.rejects(named.auditHistory, /forbidden/)
    await db.exec('reset role')
    await db.query('update public.websites set owner_id=$1 where id=$2', [owner, site])
    await identity(owner)
    assert.equal((await named.auditHistory()).rows[0].independent_audit_history.items.length, 1)
    // Fail-closed disable refuses a service_role-reachable cleanup grant and, once
    // clean, re-holds the ACLs without dropping the gate or evidence.
    const disable = await read('../rollbacks/20261205000000_comparison_pilot_scope_disable.sql')
    await db.exec('reset role')
    await db.exec(`grant execute on function public.${cleanup} to pilot_inherited`)
    await assert.rejects(() => db.exec(disable), /comparison_pilot_cleanup_hold_drift/); await db.exec('rollback')
    await db.exec(`revoke execute on function public.${cleanup} from pilot_inherited`)
    await db.exec(disable)
    await db.exec('reset role')
    assert.notEqual((await db.query("select to_regclass('public.comparison_pilot_approved_sites') name")).rows[0].name, null)
    assert.equal((await db.query("select count(*)::int n from public.independent_audit_imports where website_id=$1", [site])).rows[0].n, 1)
    for (const name of held) for (const role of ['anon', 'authenticated']) assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed', [role, `public.${name}`, 'execute'])).rows[0].allowed, false)
    assert.equal((await db.query("select has_function_privilege('authenticated',$1,'execute') allowed", [`public.${cleanup}`])).rows[0].allowed, false)
  } finally { await db.close() }
})
