import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
test('search crawl seam isolates owners, preserves exact identities and never infers passes', async () => {
 const db = new PGlite(); const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', delivery='00000000-0000-0000-0000-000000000004'
 try {
  await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema public,auth to authenticated; create table public.websites(id uuid,owner_id uuid,fqdn text);create table public.seosmith_audits(delivery_id uuid,website_id uuid,fqdn text,generation bigint,scan_at timestamptz,received_at timestamptz,ingestion_source text,report jsonb);`)
  await db.exec(await readFile(new URL('../migrations/20261123000000_search_crawl_evidence.sql',import.meta.url),'utf8'))
  const doc={schema_version:2,engine_version:'1',ruleset_version:'r',pages:[{url:'https://example.com/a'},{url:'https://example.com/b'}],findings:[{url:'https://example.com/a',rule:'one'},{url:'https://example.com/a',rule:'two'},{url:'https://example.com/b',rule:'other'}],evidence_contract:{observations:[{entity_id:'entity-a',source_locator:'/pages/0'}],evaluations:[{entity_id:'entity-a',rule:'one',rule_version:'1',validator_version:'1',outcome:'fail',source_locator:'/findings/0'}]}}
  await db.query('insert into public.websites values($1,$2,$3)',[site,owner,'example.com']); await db.query("insert into public.seosmith_audits values($1,$2,'example.com',7,now(),now(),'owner_import',$3)",[delivery,site,doc])
  const identity=async(user,anonymous=false)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})])}
  const read=async(url='https://example.com/a',after=-1)=> (await db.query('select public.search_crawl_evidence($1,$2,$3,$4,-1,1) as data',[site,delivery,url,after])).rows[0].data
  await identity(other);await assert.rejects(()=>read(),/Website not found/);await identity(owner,true);await assert.rejects(()=>read(),/Website not found/)
  await identity(owner);const a=await read();assert.equal(a.ingestion_source,'owner_import');assert.equal(a.binding_generation,7);assert.equal(a.coverage,'unknown');assert.equal(a.findings[0].source_locator,'/findings/0');assert.equal(a.evaluations[0].evaluation.rule_version,'1');assert.equal(a.findings_has_more,true)
  const b=await read('https://example.com/a',a.next_finding_after);assert.equal(b.findings[0].source_locator,'/findings/1');assert.equal(b.findings_has_more,false)
  const missing=await read('https://example.com/A');assert.deepEqual(missing.findings,[]);assert.deepEqual(missing.entity_ids,[]);assert.equal(missing.coverage,'unknown')
  await db.exec('reset role');await db.query("update public.websites set fqdn='new.example.com' where id=$1",[site]);await identity(owner);assert.equal((await read()).reason,'delivery_unavailable')
 } finally {await db.close()}
})
