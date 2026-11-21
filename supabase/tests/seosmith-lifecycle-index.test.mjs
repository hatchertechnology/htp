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
  let result=await read(2);assert.deepEqual(result.items.map(x=>x.evidence_state),['unsupported','legacy_unknown']);assert.equal(result.has_more,true)
  result=await read(2,result.next_cursor.before,result.next_cursor.before_id);assert.equal(result.items[0].evaluation.rule,rule);assert.equal(result.items[1].evidence_state,'index_pending')
  await assert.rejects(()=>db.query('select public.seosmith_lifecycle_backfill(1)'),/permission denied/)
  await setOwner(id(9));await assert.rejects(()=>read(),/forbidden/)
  await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:true})]);await assert.rejects(()=>read(),/forbidden/)
  await setOwner(owner);await assert.rejects(()=>db.query('select public.seosmith_lifecycle_history($1,$2,$3,101)',[site,entity,rule]),/invalid_lifecycle_query/)
  const absent=await db.query('select public.seosmith_lifecycle_history($1,$2,$3) h',[site,'sha256:'+'a'.repeat(64),rule]);assert.equal(absent.rows[0].h.items[2].evidence_state,'not_observed')
  await db.exec('reset role;set role service_role');assert.equal((await db.query('select public.seosmith_lifecycle_backfill(10) n')).rows[0].n,1);assert.equal((await db.query('select public.seosmith_lifecycle_backfill(10) n')).rows[0].n,0)
  await setOwner(owner);result=await read();assert.equal(result.items[3].evaluation.rule,rule)
  await db.exec('reset role');assert.deepEqual((await db.query('select report from public.seosmith_audits where delivery_id=$1',[id(1)])).rows[0].report,v2)
 } finally {await db.close()}
})
