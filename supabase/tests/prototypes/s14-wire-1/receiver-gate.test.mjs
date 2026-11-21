// Candidate-only safety gate: the actual receiver remains closed to schema 4.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('test-only preflight leaves both real ingestion paths closed to schema 4', {skip: !directory && 'Set S14_CANDIDATE_DIR to the pinned candidate bundle'},async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x]))
 const db=new PGlite(), token='x'.repeat(64), owner='00000000-0000-0000-0000-000000000001'
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;`)
  for(const f of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql','20261101054016_seosmith_expanded_evidence.sql','20261101060006_seosmith_policy_exclusions.sql','20261116210550_seosmith_versioned_receiver.sql','20261116221958_seosmith_summary_target_lookup.sql','20261116223631_h01_scanner_budget.sql','20261116224641_seosmith_summary_compact_input.sql','20261117120000_seosmith_ingest_budget.sql','20261121120000_seosmith_input_cap.sql','20261121130000_seosmith_rfc3339_intervals.sql']) await db.exec(await readFile(new URL('../../../migrations/'+f,import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('raw-preflight.sql',import.meta.url),'utf8'))
  await db.query('insert into auth.users values($1)',[owner]); const site='00000000-0000-4000-8000-000000000002'; await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner]);await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)',[site,sha(token)])
  for(const name of ['v4-candidate-complete.json','invalid-escaped-duplicate-root.json','invalid-escaped-duplicate-nested.json','invalid-schema-fraction.json','invalid-depth65.json']) {
   const bytes=await readFile(`${directory}/${name}`);assert.equal(sha(bytes),entries.get(name).sha256);const raw=bytes.toString('utf8');const id='00000000-0000-4000-8000-000000000001'
   await db.exec('reset role;set role anon'); await assert.rejects(()=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',[token,id,sha(bytes),raw]))
   await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})]);await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[site,raw]))
   await db.exec('reset role'); assert.equal((await db.query('select count(*)::int as n from public.seosmith_audits')).rows[0].n,0)
  }
  const caps=(await db.query('select public.seosmith_receiver_capabilities() as caps')).rows[0].caps;assert.deepEqual(caps.schema_versions,[1,2])
 }finally{await db.close()}
})
