import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const held = [
  'import_independent_audit(uuid,text,text,jsonb)', 'independent_audit_history(uuid,uuid,timestamptz,uuid)', 'save_independent_comparison(uuid,uuid,uuid,boolean)',
  'independent_comparison_history(uuid,timestamptz,uuid)', 'independent_comparison_detail(uuid,uuid)', 'independent_evidence_fingerprint(uuid)',
  'delete_independent_audit_evidence(uuid,text,text)', 'delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)',
]
const owner = '00000000-0000-0000-0000-000000000001', site = '00000000-0000-0000-0000-000000000003', delivery = '00000000-0000-0000-0000-000000000008'
const source = 'url,rule,state\r\nhttps://example.com/,missing_title,present\r\n'

// A database at the ledger-57 comparison state: 20261124 plus the pilot gate, public ACLs held.
async function baseline() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
  for (const file of ['20261028142440_create_websites.sql', '20261031053344_seosmith_audits.sql', '20261124000000_independent_audit_comparisons.sql']) await db.exec(await read(`../migrations/${file}`))
  for (const name of held.slice(0, 7)) await db.exec(`revoke execute on function public.${name} from public,anon,authenticated`)
  await db.exec(await read('../migrations/20261205000000_comparison_pilot_scope.sql'))
  await db.query('insert into auth.users values($1)', [owner])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')", [site, owner])
  await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,repeat('a',64),'{}')", [delivery, site])
  return db
}
const acls = async db => (await db.query("select p.oid::regprocedure::text sig, coalesce(p.proacl::text,'') acl from pg_proc p where pronamespace='public'::regnamespace and proname = any($1) order by 1", [held.map(h => h.split('(')[0])])).rows

test('migration 13 widens semantics, saves s15-metadata-2 and moves no grant', async () => {
  const db = await baseline()
  try {
    const migration = await read('../migrations/20261213000000_comparison_semantics_s4.sql')
    // The held state, then an R2-like state with the owner approved and the eight functions granted.
    const heldAcls = await acls(db)
    await db.query("insert into public.independent_audit_imports(id,website_id,fqdn,format,source_text,source_sha256,metadata) values('00000000-0000-0000-0000-000000000006',$1,'example.com','controlled-csv-v1',$2,repeat('b',64),'{}')", [site, source])
    await db.query("insert into public.independent_audit_comparisons(id,website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values('00000000-0000-0000-0000-000000000007',$1,'example.com','00000000-0000-0000-0000-000000000006',$2,'s15-metadata-1',true)", [site, delivery])
    await assert.rejects(() => db.exec("insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values('" + site + "','example.com','00000000-0000-0000-0000-000000000006','" + delivery + "','s15-metadata-2',true)"), /semantics_check/)
    await db.exec(migration)
    assert.deepEqual(await acls(db), heldAcls)
    // An existing s15-metadata-1 row survives, and both known values are now valid, an unknown one is not.
    assert.equal((await db.query("select count(*)::int n from public.independent_audit_comparisons where semantics='s15-metadata-1'")).rows[0].n, 1)
    await db.exec("insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values('" + site + "','example.com','00000000-0000-0000-0000-000000000006','" + delivery + "','s15-metadata-2',true)")
    await assert.rejects(() => db.exec("insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values('" + site + "','example.com','00000000-0000-0000-0000-000000000006','" + delivery + "','s15-metadata-3',true)"), /semantics_check/)
    await db.exec('delete from public.independent_audit_comparisons where semantics=\'s15-metadata-2\'')
    // R2-like: approve the pair and grant the eight functions. The RPC now records s15-metadata-2.
    await db.query('insert into public.comparison_pilot_approved_sites values($1,$2)', [site, owner])
    for (const name of held) await db.exec(`grant execute on function public.${name} to authenticated`)
    await db.exec('set role authenticated')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, is_anonymous: false })])
    const saved = (await db.query('select public.save_independent_comparison($1,$2,$3,true) c', [site, '00000000-0000-0000-0000-000000000006', delivery])).rows[0].c
    assert.equal(saved.semantics, 's15-metadata-2')
    const history = (await db.query('select public.independent_comparison_history($1) h', [site])).rows[0].h.items
    assert.deepEqual(history.map(item => item.semantics).sort(), ['s15-metadata-1', 's15-metadata-2'])
    const detail = (await db.query('select public.independent_comparison_detail($1,$2) d', [site, '00000000-0000-0000-0000-000000000007'])).rows[0].d
    assert.equal(detail.comparison.semantics, 's15-metadata-1')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, is_anonymous: true })])
    await assert.rejects(() => db.query('select public.save_independent_comparison($1,$2,$3,true)', [site, '00000000-0000-0000-0000-000000000006', delivery]), /forbidden/)
    await db.exec('reset role')
    // Still held for the roles that never had a grant.
    for (const name of held) for (const role of ['anon']) assert.equal((await db.query('select has_function_privilege($1,$2,$3) a', [role, `public.${name}`, 'execute'])).rows[0].a, false)
  } finally { await db.close() }
})

test('migration 13 refuses drift and is atomic', async () => {
  const migration = await read('../migrations/20261213000000_comparison_semantics_s4.sql')
  const constraint = db => db.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='independent_audit_comparisons_semantics_check'").then(r => r.rows[0].d)
  // Function body drift.
  let db = await baseline()
  try {
    await db.exec("alter function public.save_independent_comparison(uuid,uuid,uuid,boolean) set search_path=public")
    await assert.rejects(() => db.exec(migration), /comparison_semantics_function_drift/)
    await db.exec('rollback')
    assert.match(await constraint(db), /s15-metadata-1/); assert.doesNotMatch(await constraint(db), /s15-metadata-2/)
  } finally { await db.close() }
  // Constraint drift.
  db = await baseline()
  try {
    await db.exec("alter table public.independent_audit_comparisons drop constraint independent_audit_comparisons_semantics_check; alter table public.independent_audit_comparisons add constraint independent_audit_comparisons_semantics_check check (semantics in ('s15-metadata-1','x'))")
    await assert.rejects(() => db.exec(migration), /comparison_semantics_constraint_drift/)
    await db.exec('rollback')
  } finally { await db.close() }
  // Missing pilot gate (the migration must apply after 20261205).
  db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select null::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql', '20261031053344_seosmith_audits.sql', '20261124000000_independent_audit_comparisons.sql']) await db.exec(await read(`../migrations/${file}`))
    await assert.rejects(() => db.exec(migration), /comparison_semantics_function_drift/)
  } finally { await db.close() }
})

test('migration 13 is idempotent only by refusing a second run', async () => {
  const db = await baseline()
  try {
    const migration = await read('../migrations/20261213000000_comparison_semantics_s4.sql')
    await db.exec(migration)
    await assert.rejects(() => db.exec(migration), /comparison_semantics_function_drift/)
  } finally { await db.close() }
})
