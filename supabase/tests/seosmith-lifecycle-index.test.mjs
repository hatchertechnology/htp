import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const site='00000000-0000-0000-0000-000000000001', owner='00000000-0000-0000-0000-000000000002'
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const v2=JSON.parse(await readFile(new URL('fixtures/contracts/v2-partial.json',import.meta.url),'utf8'))
test('index retains explicit evaluations, exposes gaps, backfills without rewriting reports and enforces ownership',async()=>{
 const db=new PGlite()
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth,public to anon,authenticated,service_role;
   create table public.websites(id uuid primary key,owner_id uuid,fqdn text);
   create table public.seosmith_audits(delivery_id uuid primary key,website_id uuid,fqdn text,scan_at timestamptz,received_at timestamptz default now(),ingestion_source text,summary jsonb,report jsonb);`)
  await db.query('insert into public.websites values($1,$2,$3)',[site,owner,'example.com'])
  const insert=(n,report)=>db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,scan_at,ingestion_source,summary,report) values($1,$2,'example.com', $3,'import',$4,$5)",[id(n),site,`2026-11-${String(n).padStart(2,'0')}T00:00:00Z`,{comparison_key:'same'},report])
  await insert(1,v2)
  await db.exec(await readFile(new URL('../migrations/20261125000000_seosmith_lifecycle_index.sql',import.meta.url),'utf8'))
  await insert(2,v2); await insert(3,{schema_version:1}); await insert(4,{schema_version:4})
  const ev=v2.evidence_contract.evaluations[0], entity=ev.entity_id,rule=ev.rule
  const setOwner=async sub=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub,is_anonymous:false})])}
  const read=(limit=50,before=null,beforeId=null)=>db.query('select public.seosmith_lifecycle_history($1,$2,$3,$4,$5,$6) h',[site,entity,rule,limit,before,beforeId]).then(x=>x.rows[0].h)
  await setOwner(owner)
  const urlEntity=v2.evidence_contract.observations.find(o=>o.state==='available').entity_id
  const urlRead=()=>db.query('select public.seosmith_url_lifecycle_history($1,$2) h',[site,urlEntity]).then(x=>x.rows[0].h)
  let urlHistory=await urlRead();assert.deepEqual(urlHistory.items.map(x=>x.evidence_state),['unsupported','legacy_unknown','available','index_pending'])
  assert.match(urlHistory.items[2].property_digests.title,/^[0-9a-f]{64}$/)
  assert.match(urlHistory.items[2].property_digests.links,/^[0-9a-f]{64}$/)
  let result=await read(2);assert.deepEqual(result.items.map(x=>x.evidence_state),['unsupported','legacy_unknown']);assert.equal(result.has_more,true)
  result=await read(2,result.next_cursor.before,result.next_cursor.before_id);assert.equal(result.items[0].evaluation.rule,rule);assert.equal(result.items[1].evidence_state,'index_pending')
  await assert.rejects(()=>db.query('select public.seosmith_lifecycle_backfill(1)'),/permission denied/)
  await assert.rejects(()=>db.query('select public.seosmith_lifecycle_reindex($1)',[id(2)]),/permission denied/)
  await assert.rejects(()=>db.query('select * from public.seosmith_lifecycle_evaluations'),/permission denied/)
  await setOwner(id(9));await assert.rejects(()=>read(),/forbidden/);await assert.rejects(()=>urlRead(),/forbidden/)
  await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:true})]);await assert.rejects(()=>read(),/forbidden/);await assert.rejects(()=>urlRead(),/forbidden/)
  await setOwner(owner);await assert.rejects(()=>db.query('select public.seosmith_lifecycle_history($1,$2,$3,101)',[site,entity,rule]),/invalid_lifecycle_query/)
  const absent=await db.query('select public.seosmith_lifecycle_history($1,$2,$3) h',[site,'sha256:'+'a'.repeat(64),rule]);assert.equal(absent.rows[0].h.items[2].evidence_state,'not_observed')
  await db.exec('reset role;set role service_role');await db.query('delete from public.seosmith_lifecycle_evaluations where delivery_id=$1',[id(2)]);await db.query('delete from public.seosmith_lifecycle_observations where delivery_id=$1',[id(2)]);await db.query('select public.seosmith_lifecycle_reindex($1)',[id(2)]);await db.query('select public.seosmith_lifecycle_reindex($1)',[id(2)]);assert.equal((await db.query('select count(*)::int n from public.seosmith_lifecycle_evaluations where delivery_id=$1',[id(2)])).rows[0].n,v2.evidence_contract.evaluations.length);assert.equal((await db.query('select count(*)::int n from public.seosmith_lifecycle_observations where delivery_id=$1',[id(2)])).rows[0].n,v2.evidence_contract.observations.length);assert.equal((await db.query('select public.seosmith_lifecycle_backfill(10) n')).rows[0].n,1);assert.equal((await db.query('select public.seosmith_lifecycle_backfill(10) n')).rows[0].n,0)
  await setOwner(owner);result=await read();assert.equal(result.items[3].evaluation.rule,rule)
  await db.exec('reset role');const indexed=(await db.query('select evaluation from public.seosmith_lifecycle_evaluations where delivery_id=$1 limit 1',[id(2)])).rows[0].evaluation;assert.equal(indexed.actual,undefined);assert.equal(indexed.expected,undefined);const page=v2.pages[0];const truncated={...page,extraction_truncated:true};const props=(await db.query('select public.seosmith_url_property_digests($1,$2) p',[truncated,'available'])).rows[0].p;assert.ok(props.status);assert.equal(props.title,undefined);assert.equal(props.links,undefined);assert.deepEqual((await db.query('select public.seosmith_url_property_digests($1,$2) p',[page,'unavailable'])).rows[0].p,{});const missing={...page};delete missing.flags;const missingProps=(await db.query('select public.seosmith_url_property_digests($1,$2) p',[missing,'available'])).rows[0].p;assert.ok(missingProps.status);assert.equal(missingProps.links,undefined);const noStatus={...page,status:null};assert.deepEqual((await db.query('select public.seosmith_url_property_digests($1,$2) p',[noStatus,'available'])).rows[0].p,{})
  assert.deepEqual((await db.query('select report from public.seosmith_audits where delivery_id=$1',[id(1)])).rows[0].report,v2)
 } finally {await db.close()}
})

// S14 schema 4 (E-db): the index treats a schema-4 audit with evidence v1 as indexed_v1 under the N2 key.
test('schema 4 indexes as indexed_v1 with the N2 key; schema 1/2 keys and unsupported states are unchanged',async()=>{
 const {createHash}=await import('node:crypto'),sha=s=>createHash('sha256').update(s).digest('hex')
 const db=new PGlite()
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth,public to anon,authenticated,service_role;
   create table public.websites(id uuid primary key,owner_id uuid,fqdn text);
   create table public.seosmith_audits(delivery_id uuid primary key,website_id uuid,fqdn text,scan_at timestamptz,received_at timestamptz default now(),ingestion_source text,summary jsonb,report jsonb);`)
  await db.query('insert into public.websites values($1,$2,$3)',[site,owner,'example.com'])
  await db.exec(await readFile(new URL('../migrations/20261125000000_seosmith_lifecycle_index.sql',import.meta.url),'utf8'))
  // E-db replaces the remediation and enqueue functions too, so their base objects must exist.
  await db.exec('alter table public.seosmith_audits add column generation bigint')
  for(const f of ['20261202000000_seosmith_remediation.sql','20261203000000_audit_event_queue.sql']) await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261212000000_s14_schema4_evidence.sql',import.meta.url),'utf8'))
  const receiverKey=sha('receiver-v5-comparison-key')
  const insert=(n,report,summary={comparison_key:receiverKey})=>db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,scan_at,ingestion_source,summary,report) values($1,$2,'example.com',$3,'worker',$4,$5)",[id(n),site,`2026-11-${String(n).padStart(2,'0')}T00:00:00Z`,summary,report])
  const row=n=>db.query('select * from public.seosmith_lifecycle_indexed where delivery_id=$1',[id(n)]).then(r=>r.rows[0])
  const count=(t,n)=>db.query(`select count(*)::int n from public.${t} where delivery_id=$1`,[id(n)]).then(r=>r.rows[0].n)
  const v4={...structuredClone(v2),schema_version:'4'}
  await insert(1,v4); await insert(2,v2); await insert(3,{schema_version:1})
  await insert(4,{...structuredClone(v4),evidence_contract:undefined})                      // schema 4 without evidence
  await insert(5,v4,{})                                                                       // schema 4, summary lacks the key
  const noEvKey=structuredClone(v4); delete noEvKey.evidence_contract.comparison_key
  await insert(6,noEvKey)                                                                     // schema 4, evidence lacks the key
  const badVersion=structuredClone(v4); badVersion.evidence_contract.version=2
  await insert(7,badVersion)                                                                  // schema 4, unknown evidence version
  const s4=await row(1)
  assert.equal(s4.state,'indexed_v1'); assert.equal(s4.schema_version,'4')
  assert.equal(s4.comparison_key,sha(`${receiverKey}\nschema:4\n${v4.evidence_contract.comparison_key}`))
  assert.equal(s4.policy_digest,v4.evidence_contract.policy.signature)
  assert.equal(await count('seosmith_lifecycle_evaluations',1),v4.evidence_contract.evaluations.length)
  assert.equal(await count('seosmith_lifecycle_observations',1),v4.evidence_contract.observations.length)
  // Schema 2 keeps the summary key verbatim (no N2 hashing); schema 1 stays legacy.
  const s2=await row(2); assert.equal(s2.state,'indexed_v1'); assert.equal(s2.comparison_key,receiverKey); assert.notEqual(s2.comparison_key,s4.comparison_key)
  assert.equal((await row(3)).state,'legacy')
  for(const n of [4,5,6,7]){const r=await row(n);assert.equal(r.state,'unsupported',`row ${n}`);assert.equal(r.comparison_key,null);assert.equal(await count('seosmith_lifecycle_evaluations',n),0)}
 } finally {await db.close()}
})
