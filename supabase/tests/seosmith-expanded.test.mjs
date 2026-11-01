import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const migration = '20261101054016_seosmith_expanded_evidence.sql'
const hash = value => createHash('sha256').update(value).digest('hex')
const owner='00000000-0000-0000-0000-000000000001',site='00000000-0000-0000-0000-000000000003'
const fixture = JSON.parse(await readFile(new URL('fixtures/seosmith-expanded.json', import.meta.url), 'utf8'))
test('expanded schema-1 evidence round-trips through workers, imports and historical reads with bounded coverage', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon,service_role;
      alter default privileges grant execute on functions to anon,authenticated;`)
    for (const name of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql']) {
      await db.exec(await readFile(new URL('../migrations/'+name, import.meta.url), 'utf8'))
    }
    await db.query('insert into auth.users values($1)', [owner])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')", [site,owner])
    const token = 'x'.repeat(64)
    await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)', [site,hash(token)])
    const identity = async () => {
      await db.exec('reset role;set role authenticated')
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({sub:owner,is_anonymous:false})])
    }
    const save = report => db.query('select public.import_seosmith_audit($1,$2) as receipt', [site,JSON.stringify(report,null,2)]).then(r=>r.rows[0].receipt)
    const detail = id => db.query('select public.seosmith_audit_detail($1,$2) as detail', [site,id]).then(r=>r.rows[0].detail)
    // Insert before upgrading: reads must fix the derived summary without changing bytes.
    const legacy = structuredClone(fixture)
    legacy.request.request_id = '00000000-0000-0000-0000-000000000009'
    legacy.engine_version = '0.1.0'; legacy.ruleset_version = 'legacy'
    legacy.pages = [{url:'https://example.com/',status:204,error:null,content_type:'application/xhtml+xml; charset=UTF-8'}]
    legacy.findings = []
    await identity(); await save(legacy)
    await db.exec('reset role')
    await db.exec(await readFile(new URL('../migrations/'+migration, import.meta.url), 'utf8'))
    await identity()
    const old = await detail(legacy.request.request_id)
    assert.equal(old.summary.pages.html,1); assert.equal(old.summary.pages.checked,1)
    assert.equal(old.summary.resources.checked,0)
    assert.equal(old.report_json,JSON.stringify(legacy,null,2))
    assert.equal(old.report.pages[0].is_resource,undefined,'legacy bytes remain intact; absence means false')
    // Exercise worker validation and exact byte retries with expanded evidence.
    await db.exec('reset role;set role anon')
    const raw = JSON.stringify(fixture,null,2), id = fixture.request.request_id
    const push = (bytes=raw, digest=hash(bytes)) => db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as receipt', [token,id,digest,bytes]).then(r=>r.rows[0].receipt)
    const receipt = await push()
    assert.deepEqual(receipt,{accepted:true,delivery_id:id,sha256:hash(raw)})
    assert.deepEqual(await push(),receipt)
    await assert.rejects(()=>push(raw+' ',hash(raw)),/invalid_delivery/)
    await assert.rejects(()=>push(raw+' '),/delivery_conflict/)
    await identity()
    const saved = await detail(id)
    assert.equal(saved.report_json,raw); assert.deepEqual(saved.report,fixture)
    assert.deepEqual(await save(fixture),receipt,'same exact bytes imported idempotently')
    assert.equal(saved.summary.pages.checked,2); assert.equal(saved.summary.resources.checked,4)
    assert.equal(saved.summary.pages.html,2); assert.equal(saved.summary.resources.html,1)
    assert.equal(saved.summary.pages.http_errors,0); assert.equal(saved.summary.resources.http_errors,2)
    assert.equal(saved.summary.coverage_complete,true)
    const manual = structuredClone(fixture)
    manual.request.request_id = '00000000-0000-0000-0000-000000000011'
    await save(manual); assert.deepEqual((await detail(manual.request.request_id)).report,manual)
    const history = (await db.query('select public.seosmith_audit_history($1) as h',[site])).rows[0].h
    assert.equal(history.items.find(r=>r.delivery_id===legacy.request.request_id).summary.pages.html,1)
    assert.deepEqual(history.items.find(r=>r.delivery_id===id).summary,saved.summary)
    await db.exec('reset role')
    const summary = r => db.query('select public.seosmith_summary($1::jsonb) as s',[JSON.stringify(r)]).then(r=>r.rows[0].s)
    for (const stop_reason of ['resource_limit','page_limit','legacy_checkpoint_metadata','discovery_or_extraction_limit']) {
      assert.equal((await summary({...fixture,stop_reason})).coverage_complete,false,stop_reason)
    }
    for (const mutate of [
      r=>{r.pages[0].extraction_truncated=true},
      r=>{r.pages[0].flags=['extraction_limit']},
      r=>{r.pages[0].flags=['legacy_checkpoint_metadata']},
      r=>{r.pages[0].blocked_by_robots=true},
      r=>{r.pages[0].error='failed'},
      ...['not_fetched','blocked','outside_scope','fetch_failed'].map(state=>r=>{r.pages[0].relationships[0].state=state}),
      r=>{r.pages[0].relationships[0].url='https://example.com/unobserved'},
      r=>{r.pages[1].status=null}
    ]) {
      const r=structuredClone(fixture);mutate(r)
      assert.equal((await summary(r)).coverage_complete,false)
    }
    assert.equal((await summary({...fixture,pages:[{status:200,content_type:'text/html'},{status:201,content_type:' APPLICATION/XHTML+XML ; charset=utf-8'},{status:299,content_type:'application/vnd.wap.xhtml+xml'},{status:304,content_type:'text/html'},{status:200,content_type:'text/html-invalid'}]})).pages.html,3)
    assert.notEqual((await summary({...fixture,request:{...fixture.request,max_resources:0}})).comparison_key,saved.summary.comparison_key)
    for (const property of ['engine_version','ruleset_version']) assert.notEqual((await summary({...fixture,[property]:'different'})).comparison_key,saved.summary.comparison_key)
    // Two independent 20k budgets fit in the existing 16 MiB protocol.
    const large = {...fixture,pages:[...Array(20000).fill({status:200,content_type:'text/html'}),...Array(20000).fill({is_resource:true,status:200,content_type:'text/html'})],findings:[]}
    large.request = {...fixture.request,request_id:'00000000-0000-0000-0000-000000000012'}
    await identity();assert.equal((await save(large)).accepted,true)
    assert.equal((await detail(large.request.request_id)).summary.pages.checked,20000)
    await db.exec('reset role;set role anon')
    const workerLarge = {...large,request:{...large.request,request_id:'00000000-0000-0000-0000-000000000014'}}
    const workerBytes=JSON.stringify(workerLarge)
    assert.equal((await db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as receipt',[token,workerLarge.request.request_id,hash(workerBytes),workerBytes])).rows[0].receipt.accepted,true)
    await identity()
    // Both entry paths reject over-budget reports, with no stored run/receipt.
    const rejected = {...large,pages:[...large.pages,{is_resource:true}]}
    rejected.request = {...large.request,request_id:'00000000-0000-0000-0000-000000000013'}
    await assert.rejects(()=>save(rejected),/invalid_seosmith_findings|report_limit/)
    assert.equal(await detail(rejected.request.request_id),null)
    await db.exec('reset role;set role anon')
    const bytes=JSON.stringify(rejected)
    await assert.rejects(()=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',[token,rejected.request.request_id,hash(bytes),bytes]),/invalid_seosmith_findings|report_limit/)
    await db.exec('reset role')
    await assert.rejects(()=>summary({...large,pages:Array(20001).fill({})}),/report_limit/)
    await assert.rejects(()=>summary({...large,pages:Array(20001).fill({is_resource:true})}),/report_limit/)
    for (const request of [{...fixture.request,max_pages:20001},{...fixture.request,max_resources:20001},{...fixture.request,max_resources:-1}]) await assert.rejects(()=>summary({...fixture,request}),/report_limit/)
    const finding={severity:'alert',rule:'r',url:'x'}
    assert.equal((await summary({...fixture,findings:Array(400000).fill(finding)})).findings,400000)
    await assert.rejects(()=>summary({...fixture,findings:Array(400001).fill(finding)}),/invalid_seosmith_findings/)
    // The 16 MiB byte ceiling and immutable finalization remain mandatory.
    await identity();await assert.rejects(()=>save({...fixture,padding:'x'.repeat(16*1024*1024)}),/report_limit/)
    await db.exec('reset role')
    await assert.rejects(()=>db.query("update public.seosmith_audits set summary='{}' where delivery_id=$1",[id]),/audit_is_immutable/)
    const grants=(await db.query("select has_function_privilege('anon','public.seosmith_observation_counts(jsonb)','execute') as anon,has_function_privilege('authenticated','public.seosmith_summary(jsonb)','execute') as authenticated")).rows[0]
    assert.deepEqual(grants,{anon:false,authenticated:false})
  } finally { await db.close() }
})
