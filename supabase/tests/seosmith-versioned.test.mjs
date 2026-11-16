import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const hash = value => createHash('sha256').update(value).digest('hex')
const owner='00000000-0000-0000-0000-000000000001',site='00000000-0000-0000-0000-000000000003'
const legacy = JSON.parse(await readFile(new URL('fixtures/seosmith-expanded.json', import.meta.url), 'utf8'))
const migration = '20261116210550_seosmith_versioned_receiver.sql'
async function setup() {
  const db = new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    alter default privileges grant execute on functions to anon,authenticated;`)
  for (const name of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql','20261101054016_seosmith_expanded_evidence.sql','20261101060006_seosmith_policy_exclusions.sql']) {
    await db.exec(await readFile(new URL('../migrations/'+name, import.meta.url), 'utf8'))
  }
  await db.query('insert into auth.users values($1)',[owner])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)',[site,hash('x'.repeat(64))])
  return db
}
const upgrade = async db => db.exec(await readFile(new URL('../migrations/'+migration, import.meta.url), 'utf8'))
const identity = async db => {
  await db.exec('reset role;set role authenticated')
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
}
test('receiver upgrade retains legacy bytes and receipts; old receiver rejects new schemas', async () => {
  const db=await setup()
  try {
    const raw=JSON.stringify(legacy,null,2),id=legacy.request.request_id
    const push = bytes => db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as receipt',['x'.repeat(64),id,hash(bytes),bytes]).then(r=>r.rows[0].receipt)
    await db.exec('set role anon')
    const receipt=await push(raw)
    await assert.rejects(()=>push(JSON.stringify({...legacy,schema_version:2})),/invalid_binding_or_report/)
    await db.exec('reset role');await upgrade(db)
    await db.exec('set role anon')
    assert.deepEqual(await push(raw),receipt)
    const caps=(await db.query('select public.seosmith_receiver_capabilities() as c')).rows[0].c
    assert.equal(caps.max_report_bytes,16777216)
    assert.equal(caps.exact_bytes,true)
    assert.ok(caps.schema_versions.includes(1))
    await identity(db)
    const detail=(await db.query('select public.seosmith_audit_detail($1,$2) as d',[site,id])).rows[0].d
    assert.equal(detail.report_json,raw)
    assert.deepEqual(detail.report,legacy)
    assert.deepEqual((await db.query('select public.import_seosmith_audit($1,$2) as r',[site,raw])).rows[0].r,receipt)
    await assert.rejects(()=>db.query('select public.seosmith_legacy_summary($1)',[legacy]),/permission denied/)
  } finally { await db.close() }
})
