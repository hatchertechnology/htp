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
const upgrade = async db => {
  await db.exec(await readFile(new URL('../migrations/'+migration, import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261116221958_seosmith_summary_target_lookup.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261116223631_h01_scanner_budget.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261116224641_seosmith_summary_compact_input.sql', import.meta.url), 'utf8'))
}
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
    const cached=(await db.query('select summary_version,summary from public.seosmith_summary_cache where delivery_id=$1',[id])).rows[0]
    assert.equal(cached.summary_version,4)
    assert.equal(cached.summary.evidence_state,'legacy_unknown')
    assert.equal((await db.query("select summary->>'summary_version' as version,raw_report_json from public.seosmith_audits where delivery_id=$1",[id])).rows[0].raw_report_json,raw)
    await db.exec('set role anon')
    assert.deepEqual(await push(raw),receipt)
    const caps=(await db.query('select public.seosmith_receiver_capabilities() as c')).rows[0].c
    assert.equal(caps.max_report_bytes,16777216)
    assert.equal(caps.exact_bytes,true)
    assert.ok(caps.schema_versions.includes(1))
    await identity(db)
    const history=(await db.query('select public.seosmith_audit_history($1) as h',[site])).rows[0].h
    assert.deepEqual(history.items[0].summary,cached.summary)
    const detail=(await db.query('select public.seosmith_audit_detail($1,$2) as d',[site,id])).rows[0].d
    assert.equal(detail.report_json,raw)
    assert.deepEqual(detail.report,legacy)
    assert.deepEqual((await db.query('select public.import_seosmith_audit($1,$2) as r',[site,raw])).rows[0].r,receipt)
    await assert.rejects(()=>db.query('select public.seosmith_legacy_summary($1)',[legacy]),/permission denied/)
  } finally { await db.close() }
})

test('exact UTF-8 boundary applies to worker and import without accepted oversized rows', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const max=16777216,raw=JSON.stringify(legacy),id=legacy.request.request_id
    // JSON trailing whitespace is legal and is part of the immutable hash.
    const boundary=raw+' '.repeat(max-Buffer.byteLength(raw))
    await db.exec('set role anon')
    const push=bytes=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as r',['x'.repeat(64),id,hash(bytes),bytes]).then(r=>r.rows[0].r)
    assert.equal((await push(boundary)).accepted,true)
    await assert.rejects(()=>push(boundary+' '),/invalid_delivery/)
    const oversized=JSON.stringify({...legacy,padding:'é'.repeat(max/2)})
    assert.ok(oversized.length<max)
    assert.ok(Buffer.byteLength(oversized)>max)
    await assert.rejects(()=>push(oversized),/invalid_delivery/)
    await identity(db)
    assert.equal((await db.query('select public.import_seosmith_audit($1,$2) as r',[site,boundary])).rows[0].r.accepted,true)
    await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[site,boundary+' ']),/report_limit/)
    await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[site,oversized]),/report_limit/)
    await db.exec('reset role')
    assert.equal((await db.query('select count(*)::int as n from public.seosmith_audits')).rows[0].n,1)
    const stored=(await db.query('select raw_report_json,sha256 from public.seosmith_audits')).rows[0]
    assert.equal(stored.raw_report_json,boundary)
    assert.equal(stored.sha256,hash(boundary))
  } finally { await db.close() }
})

test('frozen versioned contract validates through worker and owner import', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    await db.query('delete from public.websites where id=$1',[site])
    for (const name of ['v2-complete','v2-partial','v2-truncated']) {
      const raw=await readFile(new URL('fixtures/contracts/'+name+'.json',import.meta.url),'utf8')
      const report=JSON.parse(raw),id=report.request.request_id
      // Shared fixtures retain producer bytes and their native website identity.
      await db.query('insert into public.websites(id,owner_id,fqdn) values($1,$2,$3) on conflict do nothing',[report.request.website_id,owner,'example.com'])
      await db.query('delete from public.seosmith_bindings')
      await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)',[report.request.website_id,hash('x'.repeat(64))])
      await db.exec('set role anon')
      const receipt=(await db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as r',['x'.repeat(64),id,hash(raw),raw])).rows[0].r
      assert.deepEqual(receipt,{accepted:true,delivery_id:id,sha256:hash(raw)})
      await identity(db)
      assert.deepEqual((await db.query('select public.import_seosmith_audit($1,$2) as r',[report.request.website_id,raw])).rows[0].r,receipt)
      const detail=(await db.query('select public.seosmith_audit_detail($1,$2) as d',[report.request.website_id,id])).rows[0].d
      assert.equal(detail.report_json,raw)
      assert.deepEqual(detail.report,report)
      assert.equal(detail.summary.summary_version,4)
      assert.equal(detail.summary.schema_version,2)
      assert.equal(detail.summary.evaluation_coverage_complete,false)
      assert.equal(detail.summary.coverage_complete,false)
      await db.exec('reset role')
      await db.query('delete from public.seosmith_audits where delivery_id=$1',[id])
    }
  } finally { await db.close() }
})

test('invalid contracts never produce receipts on either path', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const fixture=JSON.parse(await readFile(new URL('fixtures/contracts/v2-complete.json',import.meta.url),'utf8'))
    await db.query('delete from public.websites where id=$1',[site])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[fixture.request.website_id,owner])
    await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)',[fixture.request.website_id,hash('x'.repeat(64))])
    const cases = [
      r=>{r.schema_version=3}, r=>{delete r.evidence_contract},
      r=>{r.evidence_contract.version=2}, r=>{r.evidence_contract.policy.signature='sha256:'+'0'.repeat(64)},
      r=>{r.evidence_contract.observations[0].source_locator='/pages/9999'},
      r=>{r.evidence_contract.observations[0].entity_id='sha256:'+'0'.repeat(64)},
      r=>{r.evidence_contract.evaluations.push(structuredClone(r.evidence_contract.evaluations[0]))},
      r=>{r.evidence_contract.evaluations[0].outcome='unknown';r.evidence_contract.evaluations[0].unknown_reason=null},
      r=>{r.evidence_contract.coverage.pop()},
      r=>{r.evidence_contract.coverage[0].unknown=0},
      r=>{r.evidence_contract.evaluation_coverage_complete=true},
      r=>{r.evidence_contract.omitted_observations=1},
      r=>{r.evidence_contract.evaluations[0].actual={state:'source',source_locator:'/pages/9999/title'}},
      r=>{r.evidence_contract.padding='x'.repeat(1048577)},
      r=>{r.schema_version=1}
    ]
    for (const extra of ['\"duplicate\":{\"a\":1,\"a\":2}', '\"deep\":'+ '['.repeat(64)+'0'+']'.repeat(64)]) {
      const raw=JSON.stringify(fixture).replace(/}$/,','+extra+'}')
      await db.exec('reset role;set role anon')
      await assert.rejects(()=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',['x'.repeat(64),fixture.request.request_id,hash(raw),raw]))
      await identity(db)
      await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[fixture.request.website_id,raw]))
    }
    const whitespace = ['\t','\n','\r'];
    const malicious = [];
    for (const ws of whitespace) {
      malicious.push(JSON.stringify(fixture).replace('{"schema_version":2',`{"schema_version"${ws}:${ws}2${ws}` ).replace(/}$/,',"padding":{"a":1,"a":2}}'))
      malicious.push(JSON.stringify(fixture).replace('{"schema_version":2',`{"schema_version"${ws}:${ws}2${ws}`).replace(/}$/,',"padding":'+ '['.repeat(65)+'0'+']'.repeat(65)+'}'))
    }
    for (const first of ['1','2','\\u0032']) {
      malicious.push(JSON.stringify(fixture).replace('{"schema_version":2',`{"schema_version":"${first}","schema_version":2`))
      malicious.push(JSON.stringify(fixture).replace('{"schema_version":2',`{"schema_version":"${first}","schema_version":2`).replace(/}$/,',"padding":'+ '['.repeat(65)+'0'+']'.repeat(65)+'}'))
    }
    for (const raw of malicious) {
      await db.exec('reset role;set role anon')
      await assert.rejects(()=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',['x'.repeat(64),fixture.request.request_id,hash(raw),raw]))
      await identity(db)
      await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[fixture.request.website_id,raw]))
    }
    for (const mutate of cases) {
      const report=structuredClone(fixture);mutate(report);const raw=JSON.stringify(report)
      await db.exec('reset role;set role anon')
      await assert.rejects(()=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',['x'.repeat(64),report.request.request_id,hash(raw),raw]))
      await identity(db)
      await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[report.request.website_id,raw]))
    }
    await db.exec('reset role')
    assert.equal((await db.query('select count(*)::int as n from public.seosmith_audits')).rows[0].n,0)
  } finally { await db.close() }
})

test('raw parser vectors enforce decoded uniqueness and depth without changing legacy behavior', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const vectors=JSON.parse(await readFile(new URL('fixtures/contracts/raw-validation-vectors.json',import.meta.url),'utf8'))
    for (const v of vectors) {
      const inner=v.depth ? '['.repeat(v.depth-1)+'0'+']'.repeat(v.depth-1) : v.suffix
      const raw=v.raw ?? `{"schema_version":${v.schema},"data":${inner}}`
      const check=()=>db.query('select public.seosmith_check_raw_report($1)',[raw])
      if (v.accepted) await check(); else await assert.rejects(check,undefined,v.name)
    }
    await assert.rejects(()=>db.query('select public.seosmith_check_raw_report($1)', ['{"schema_version":2.0,"schema_version":1}']),/duplicate/)
    await assert.rejects(()=>db.query('select public.seosmith_check_raw_report($1)', ['{"schema_vers\\u0069on":2,"x":{"a":1,"a":2}}']),/duplicate/)
  } finally { await db.close() }
})

test('legacy rows that fail modern derivation are cached as unknown without changing bytes', async () => {
  const db=await setup()
  try {
    const raw=JSON.stringify(legacy), id=legacy.request.request_id
    await identity(db)
    await db.query('select public.import_seosmith_audit($1,$2)',[site,raw])
    await db.exec('reset role;alter table public.seosmith_audits disable trigger seosmith_immutable_audit')
    await db.query("update public.seosmith_audits set report=jsonb_set(report,'{pages}','null'::jsonb) where delivery_id=$1",[id])
    await db.exec('alter table public.seosmith_audits enable trigger seosmith_immutable_audit')
    await upgrade(db)
    const cached=(await db.query('select summary from public.seosmith_summary_cache where delivery_id=$1',[id])).rows[0].summary
    assert.equal(cached.summary_derivation_failed,true)
    assert.equal(cached.coverage_complete,false)
    assert.equal((await db.query('select raw_report_json from public.seosmith_audits where delivery_id=$1',[id])).rows[0].raw_report_json,raw)
    await identity(db)
    assert.deepEqual((await db.query('select public.seosmith_audit_history($1) as h',[site])).rows[0].h.items[0].summary,cached)
  } finally { await db.close() }
})

test('raw scanning skips token-heavy legacy and rejects obvious excessive v2 depth promptly', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const legacyRaw='{"schema_version":1,"padding":['+'0,'.repeat(7_999_000)+'0]}'
    const started=performance.now()
    await db.query('select public.seosmith_check_raw_report($1)',[legacyRaw])
    assert.ok(performance.now()-started<10000,'legacy fast path must avoid token-by-token iteration')
    const deep='{"schema_version":2,"padding":'+'['.repeat(1_000_000)+'0'+']'.repeat(1_000_000)+'}'
    const startDeep=performance.now()
    await assert.rejects(()=>db.query('select public.seosmith_check_raw_report($1)',[deep]),/report_depth_limit/)
    assert.ok(performance.now()-startDeep<10000,'deep v2 must reject before token materialization')
    const safe='{"schema_version":2,"text":"'+'['.repeat(65)+'"}'
    await db.query('select public.seosmith_check_raw_report($1)',[safe])
  } finally { await db.close() }
})

test('incremental scanner handles chunk boundaries, Unicode and non-contiguous depth', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const check=s=>db.query('select public.seosmith_check_raw_report($1)',[s])
    for (const n of [16370,16371,16372,16373,16374,16375,16376,16377,16378,16379,16380,16381,16382,16383,16384]) {
      const prefix='{"padding":"'+ 'é'.repeat(n)+'\\\"[{]","schema_vers\\u0069on":2,"x":'
      await check(prefix+'0}')
      await assert.rejects(()=>check(prefix+'{"a":1,"\\u0061":2}}'),/duplicate/)
    }
    const deep='{"schema_version":2,"x":'+ '{"x":'.repeat(64)+'0'+'}'.repeat(64)+'}'
    await assert.rejects(()=>check(deep),/report_depth_limit/)
    await assert.rejects(()=>check('{"schema_version"   : 2, "a":1, "a":2}'),/duplicate/)
    const exact='{"schema_version":2,"x":'+ '{"x":'.repeat(63)+'0'+'}'.repeat(63)+'}'
    await check(exact)
  } finally { await db.close() }
})

test('token-heavy schema-2 input at the 16 MiB bound stays bounded', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const raw='{"schema_version":2,"padding":['+'0,'.repeat(7_999_000)+'0]}'
    assert.ok(Buffer.byteLength(raw)<16777216)
    const start=performance.now()
    await db.query('select public.seosmith_check_raw_report($1)',[raw])
    assert.ok(performance.now()-start<120000,'bounded token scan exceeded two minutes')
  } finally { await db.close() }
})


test('target lookup preserves coverage and summaries across checked, missing, duplicate, and excluded relationships', async () => {
  const db=await setup()
  try {
    await db.exec(await readFile(new URL('../migrations/'+migration, import.meta.url), 'utf8'))
    const samples=[]
    for (const kind of ['checked','missing','unknown','excluded','duplicate','null-url']) {
      const r=structuredClone(legacy)
      const rel=r.pages[0].relationships[0]
      if (kind==='missing') rel.url='https://example.com/missing'
      if (kind==='unknown') rel.state='not_fetched'
      if (kind==='excluded') Object.assign(rel,{kind:'navigation',url:'https://outside.example/',state:'outside_scope',resource:false})
      if (kind==='duplicate') r.pages.push(structuredClone(r.pages[1]))
      if (kind==='null-url') rel.url=null
      samples.push(r)
    }
    const summarize=async r=>(await db.query('select public.seosmith_summary($1) as s',[r])).rows[0].s
    const expected=[]
    for (const r of samples) expected.push(await summarize(r))
    await db.exec(await readFile(new URL('../migrations/20261116221958_seosmith_summary_target_lookup.sql', import.meta.url), 'utf8'))
    for (let i=0;i<samples.length;i++) assert.deepEqual(await summarize(samples[i]),expected[i])
  } finally { await db.close() }
})

test('nested string batching preserves depth, escape and duplicate-key checks at chunk boundaries', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const check=s=>db.query('select public.seosmith_check_raw_report($1)',[s])
    for (const n of [16360,16370,16380,16383,16384,16385]) {
      const prefix='{"schema_version":2,"x":['+JSON.stringify('é'.repeat(n)+'\\"[{}]')+','
      await check(prefix+'"safe"]}')
      await assert.rejects(()=>check(prefix+'{"a":1,"\\u0061":2}]}'),/duplicate/)
      await assert.rejects(()=>check(prefix+'['.repeat(64)+'0'+']'.repeat(64)+']}'),/report_depth_limit/)
    }
  } finally { await db.close() }
})


test('batched scanner agrees with H01 on adversarial raw inputs', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const oldSql=await readFile(new URL('../migrations/'+migration, import.meta.url),'utf8')
    const start=oldSql.indexOf('create function public.seosmith_check_raw_report(')
    const end=oldSql.indexOf('revoke all on function public.seosmith_check_raw_report',start)
    await db.exec(oldSql.slice(start,end).replace('public.seosmith_check_raw_report(', 'public.seosmith_check_raw_report_baseline('))
    const outcome=async (name,raw)=>{
      try { await db.query(`select public.${name}($1)`,[raw]); return 'accepted' }
      catch (e) { return e.message }
    }
    const cases=[
      ...[16360,16370,16380,16383,16384,16385].flatMap(n=>{
        const a=JSON.stringify('é'.repeat(n)+'\\"[]{}')
        return [`{"schema_version":2,"x":[${a},"x",{"a":1}]}`,
          `{"schema_version":2,"x":[${a},{"a":1,"\\u0061":2}]}`,
          `{"x":[${a},${'['.repeat(64)}0${']'.repeat(64)}],"schema_version":2}`]
      }),
      '{"schema_version":2,"x":['+'"[{\\"x\\":]}",'.repeat(4000)+'"z"]}',
      '{"schema_version":2,"x":['+'0,'.repeat(10000)+'0]}',
      '{"schema_version":1,"x":'+ '['.repeat(70)+'0'+']'.repeat(70)+'}',
      '{"schema_version":2,"x":'+ '['.repeat(63)+'0'+']'.repeat(63)+'}',
      '{"schema_version":2,"x":'+ '['.repeat(64)+'0'+']'.repeat(64)+'}'
    ]
    for (const n of [16355,16360,16370,16380,16383,16384,16385,16390,32760,32768]) {
      for (const slashes of [1,2,3,4,5]) {
        const content=JSON.stringify('é'.repeat(n)+'\\'.repeat(slashes)+'"[{}]')
        cases.push(`{"schema_version":2,"items":[${content}, {"x":1,"\\u0078":2}]}`)
        cases.push(`{"schema_version":2,"items":[${content}, "valid"]}`)
        cases.push(`{"schema_version":2,"padding":${content}}`)
        cases.push(`{"schema_version":2,${content}:0}`)
      }
    }
    for(const raw of cases) assert.equal(await outcome('seosmith_check_raw_report',raw),await outcome('seosmith_check_raw_report_baseline',raw))
  } finally { await db.close() }
})

test('compact v2 summary preserves results and rejection errors for unrelated root values and missing fields', async () => {
  const db=await setup()
  try {
    await db.exec(await readFile(new URL('../migrations/'+migration, import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../migrations/20261116221958_seosmith_summary_target_lookup.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../migrations/20261116223631_h01_scanner_budget.sql', import.meta.url), 'utf8'))
    const base=JSON.parse(await readFile(new URL('fixtures/contracts/v2-complete.json',import.meta.url),'utf8'))
    const cases=[base,{...base,padding:[0,1,{x:'ignored'}]},{...base,padding:null}]
    for (const name of ['v2-partial','v2-truncated']) cases.push(JSON.parse(await readFile(new URL(`fixtures/contracts/${name}.json`,import.meta.url),'utf8')))
    for (const key of ['request','started_at','engine_version','pages','findings','coverage_complete','evidence_contract']) {
      const missing=structuredClone(base); delete missing[key]; cases.push(missing)
      cases.push({...base,[key]:null})
    }
    const invalid=structuredClone(base); invalid.evidence_contract.policy.signature='bad'; cases.push(invalid)
    const evaluate=async r=>{try {return {value:(await db.query('select public.seosmith_summary($1) s',[r])).rows[0].s}} catch(e) {return {code:e.code,message:e.message}}}
    const expected=[]; for(const r of cases) expected.push(await evaluate(r))
    await db.exec(await readFile(new URL('../migrations/20261116224641_seosmith_summary_compact_input.sql',import.meta.url),'utf8'))
    for(let i=0;i<cases.length;i++) assert.deepEqual(await evaluate(cases[i]),expected[i],`case ${i}`)
  } finally {await db.close()}
})

test('RPC timeout migration changes only intended function configuration', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const snapshot=async()=> (await db.query(`select p.oid::regprocedure::text name,p.proconfig,p.proacl from pg_proc p where p.oid in ('public.ingest_seosmith_audit(text,uuid,text,text)'::regprocedure,'public.import_seosmith_audit(uuid,text)'::regprocedure,'public.seosmith_receiver_capabilities()'::regprocedure) order by 1`)).rows
    const roles=async()=> (await db.query("select rolname,rolconfig from pg_roles where rolname in ('anon','authenticated') order by rolname")).rows
    const before=await snapshot(),beforeRoles=await roles()
    await db.exec(await readFile(new URL('../migrations/20261116233148_seosmith_rpc_timeout.sql',import.meta.url),'utf8'))
    const after=await snapshot()
    for(let i=0;i<before.length;i++) {
      assert.deepEqual(after[i].proacl,before[i].proacl)
      if(after[i].name.startsWith('seosmith_receiver_capabilities')) assert.deepEqual(after[i].proconfig,before[i].proconfig)
      else assert.ok(after[i].proconfig.includes('statement_timeout=8s'))
    }
    assert.deepEqual(await roles(),beforeRoles)
  } finally {await db.close()}
})

test('ingest budget migration raises only the two ingest RPCs to a bounded 20s', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const snapshot=async()=> (await db.query(`select p.oid::regprocedure::text name,p.proconfig,p.proacl from pg_proc p where p.oid in ('public.ingest_seosmith_audit(text,uuid,text,text)'::regprocedure,'public.import_seosmith_audit(uuid,text)'::regprocedure,'public.seosmith_receiver_capabilities()'::regprocedure) order by 1`)).rows
    const roles=async()=> (await db.query("select rolname,rolconfig from pg_roles where rolname in ('anon','authenticated') order by rolname")).rows
    await db.exec(await readFile(new URL('../migrations/20261116233148_seosmith_rpc_timeout.sql',import.meta.url),'utf8'))
    const before=await snapshot(),beforeRoles=await roles()
    for(const r of before) if(!r.name.startsWith('seosmith_receiver_capabilities')) assert.ok(r.proconfig.includes('statement_timeout=8s'))
    await db.exec(await readFile(new URL('../migrations/20261117120000_seosmith_ingest_budget.sql',import.meta.url),'utf8'))
    const after=await snapshot()
    for(let i=0;i<before.length;i++) {
      assert.deepEqual(after[i].proacl,before[i].proacl)
      if(after[i].name.startsWith('seosmith_receiver_capabilities')) assert.deepEqual(after[i].proconfig,before[i].proconfig)
      else assert.ok(after[i].proconfig.includes('statement_timeout=20s'))
    }
    assert.deepEqual(await roles(),beforeRoles)
  } finally {await db.close()}
})

test('new input cap is inclusive, rejects historical retries, and preserves stored reads', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    const raw=JSON.stringify(legacy), id=legacy.request.request_id, max=4952756
    const historical=raw+' '.repeat(max+1-Buffer.byteLength(raw))
    const push=bytes=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as r',['x'.repeat(64),id,hash(bytes),bytes]).then(r=>r.rows[0].r)
    await db.exec('set role anon'); await push(historical); await db.exec('reset role')
    await db.exec(await readFile(new URL('../migrations/20261121120000_seosmith_input_cap.sql',import.meta.url),'utf8'))
    assert.equal((await db.query('select public.seosmith_receiver_capabilities() as c')).rows[0].c.max_report_bytes,max)
    await db.exec('set role anon')
    await assert.rejects(()=>push(historical),/report_limit/)
    await identity(db)
    await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[site,historical]),/report_limit/)
    assert.equal((await db.query('select public.seosmith_audit_detail($1,$2) as d',[site,id])).rows[0].d.report_json,historical)
    await db.exec('reset role')
    const newer=JSON.stringify({...legacy,request:{...legacy.request,request_id:'00000000-0000-4000-8000-000000000099'}})
    const boundary=newer+' '.repeat(max-Buffer.byteLength(newer))
    const newId='00000000-0000-4000-8000-000000000099'
    await db.exec('set role anon')
    const pushNew=bytes=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as r',['x'.repeat(64),newId,hash(bytes),bytes]).then(r=>r.rows[0].r)
    await assert.rejects(()=>pushNew(boundary+' '),/report_limit/)
    await assert.rejects(()=>pushNew(boundary.slice(0,-1)+'é'),/report_limit/)
    const receipt=await pushNew(boundary); assert.equal(receipt.accepted,true); assert.deepEqual(await pushNew(boundary),receipt)
    await identity(db)
    assert.deepEqual((await db.query('select public.import_seosmith_audit($1,$2) as r',[site,boundary])).rows[0].r,receipt)
    await assert.rejects(()=>db.query('select public.import_seosmith_audit($1,$2)',[site,boundary+' ']),/report_limit/)
    await db.exec('reset role')
    await db.exec(await readFile(new URL('../rollbacks/20261121120000_seosmith_input_cap.sql',import.meta.url),'utf8'))
    assert.equal((await db.query('select public.seosmith_receiver_capabilities() as c')).rows[0].c.max_report_bytes,16777216)
    await db.exec('set role anon'); assert.equal((await push(historical)).accepted,true)
  } finally { await db.close() }
})

test('v2 interval accepts bounded explicit RFC3339 offsets and orders instants', async () => {
  const db=await setup()
  try {
    await upgrade(db)
    await db.exec(await readFile(new URL('../migrations/20261121130000_seosmith_rfc3339_intervals.sql',import.meta.url),'utf8'))
    const base=JSON.parse(await readFile(new URL('fixtures/contracts/v2-complete.json',import.meta.url),'utf8'))
    const interval=(start,end) => {
      const report=structuredClone(base)
      report.started_at=start; report.finished_at=end
      report.evidence_contract.observed_at={started_at:start,finished_at:end}
      return report
    }
    const validate=report=>db.query('select public.seosmith_validate_evidence($1::jsonb)',[JSON.stringify(report)])
    await validate(interval('2026-11-16T12:00:00Z','2026-11-16T12:01:00Z'))
    await validate(interval('2026-11-16T12:00:00.123Z','2026-11-16T12:00:01.123456789+00:00'))
    // Lexically earlier finish is a later instant when its offset differs.
    await validate(interval('2026-11-16T12:00:00+02:00','2026-11-16T11:01:00+01:00'))
    await validate(interval('2026-11-16T12:00:00-05:00','2026-11-17T07:00:00+14:00'))
    await validate(interval('2026-11-16t12:00:00z','2026-11-17T03:01:00+15:00'))
    await validate(interval('2026-11-16T12:00:00-23:59','2026-11-18T11:59:00+23:59'))
    await validate(interval('2026-11-16T12:00:00.000000001Z','2026-11-16T13:00:00.000000002+01:00'))
    await validate(interval('2026-11-16T12:00:00.12345678901234567890Z','2026-11-16T12:00:00.12345678901234567891Z'))
    for (const [start,end] of [
      ['2026-11-16T12:01:00Z','2026-11-16T12:00:00Z'],
      ['2026-11-16T12:00:00.000000002Z','2026-11-16T13:00:00.000000001+01:00'],
      ['2026-11-16T12:00:00-05:00','2026-11-16T12:01:00+01:00'],
      ['2026-02-30T12:00:00Z','2026-03-01T12:00:00Z'],
      ['2026-11-16T12:00:00','2026-11-16T12:01:00Z'],
      ['2026-11-16T24:00:00Z','2026-11-17T00:01:00Z'],
      ['2026-11-16T12:00:60Z','2026-11-16T12:01:00Z'],
      ['2026-11-16T12:00:00+24:00','2026-11-16T12:01:00Z'],
      ['2026-11-16T12:00:00+01:60','2026-11-16T12:01:00Z'],
      ['2026-11-16T12:00:00.12345678901234567891Z','2026-11-16T12:00:00.12345678901234567890Z'],
      ['2026-11-16T12:00:00.'+'1'.repeat(44)+'Z','2026-11-16T12:01:00Z'],
      ['not-a-time','2026-11-16T12:01:00Z'],
    ]) await assert.rejects(()=>validate(interval(start,end)),/invalid_evidence_interval/)
    const mismatch=interval('2026-11-16T12:00:00Z','2026-11-16T12:01:00Z')
    mismatch.evidence_contract.observed_at.finished_at='2026-11-16T12:01:00+00:00'
    await assert.rejects(()=>validate(mismatch),/invalid_evidence_interval/)
  } finally { await db.close() }
})

test('cross-path exact retries preserve the first receipt provenance', async () => {
  for (const first of ['worker', 'import']) {
    const db = await setup()
    try {
      await upgrade(db)
      for (const f of ['20261117120000_seosmith_ingest_budget.sql','20261121120000_seosmith_input_cap.sql','20261121130000_seosmith_rfc3339_intervals.sql']) await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'))
      const raw=JSON.stringify(legacy), id=legacy.request.request_id
      const worker=async()=>{await db.exec('reset role;set role anon');return (await db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) as receipt',['x'.repeat(64),id,hash(raw),raw])).rows[0].receipt}
      const ownerImport=async()=>{await identity(db);return (await db.query('select public.import_seosmith_audit($1,$2) as receipt',[site,raw])).rows[0].receipt}
      const initial=await (first==='worker' ? worker() : ownerImport())
      const retry=await (first==='worker' ? ownerImport() : worker())
      assert.deepEqual(retry,initial)
      await db.exec('reset role')
      const stored=(await db.query('select ingestion_source,raw_report_json from public.seosmith_audits where delivery_id=$1',[id])).rows[0]
      assert.equal(stored.ingestion_source,first)
      assert.equal(stored.raw_report_json,raw)
    } finally { await db.close() }
  }
})
