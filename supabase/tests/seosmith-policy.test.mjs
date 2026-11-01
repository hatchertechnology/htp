import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const fixture=JSON.parse(await readFile(new URL('fixtures/seosmith-expanded.json',import.meta.url),'utf8'))
const migration='20261101060006_seosmith_policy_exclusions.sql'
test('crawl policy exclusions preserve configured coverage without losing target uncertainty or immutable history',async()=>{
 const db=new PGlite()
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth,public to authenticated,anon,service_role;
   alter default privileges grant execute on functions to anon,authenticated;`)
  for(const name of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql','20261101054016_seosmith_expanded_evidence.sql']) await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'))
  const owner='00000000-0000-0000-0000-000000000001',site=fixture.request.website_id,id=fixture.request.request_id
  await db.query('insert into auth.users values($1)',[owner]);await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  const navigation=(url='https://outside.example/',descriptor='',state='outside_scope')=>({kind:'navigation',url,descriptor,resource:false,state})
  const withRelation=(rel,modify=()=>{})=>{const r=structuredClone(fixture);r.pages[0].relationships.push(rel);modify(r);return r}
  const excluded=withRelation(navigation())
  const raw=JSON.stringify(excluded,null,2)
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
  await db.query('select public.import_seosmith_audit($1,$2)',[site,raw])
  const storedBefore=(await db.query('select summary,report,raw_report_json,sha256 from public.seosmith_audits where delivery_id=$1',[id])).rows[0]
  assert.equal(storedBefore.summary.summary_version,2);assert.equal(storedBefore.summary.coverage_complete,false)
  await db.exec(await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8'))
  const summarize=r=>db.query('select public.seosmith_summary($1) as s',[r]).then(result=>result.rows[0].s)
  assert.equal((await summarize(excluded)).coverage_complete,true,'external navigation outside configured frontier')
  for(const descriptor of ['nofollow','sponsored','ugc','NOFOLLOW sponsored','ugc\tnoopener']) {
   const r=withRelation(navigation('https://example.com/skipped',descriptor,'not_fetched'))
   assert.equal((await summarize(r)).coverage_complete,true,descriptor)
   assert.deepEqual(r.pages[0].relationships.at(-1).state,'not_fetched','exclusion is still unknown evidence')
  }
  for(const robots of ['nofollow','NONE','noindex, nofollow']) assert.equal((await summarize(withRelation(navigation('https://example.com/skipped','','not_fetched'),r=>{r.pages[0].robots=robots}))).coverage_complete,true,robots)
  const resourceHTML=structuredClone(fixture)
  resourceHTML.pages.at(-1).relationships=[navigation('https://example.com/not-discovered','','not_fetched')]
  assert.equal((await summarize(resourceHTML)).coverage_complete,true,'resource HTML does not expand navigation')
  for(const r of [
   withRelation(navigation(),r=>{r.request.check_external_links=true}),
   withRelation(navigation('https://example.com/missing','','not_fetched')),
   withRelation(navigation('https://example.com/missing')),
   withRelation(navigation('https://outside.example/','','checked')),
   withRelation(navigation('https://example.com/missing','notnofollow','not_fetched')),
   withRelation({...navigation(),kind:'canonical'}),
   withRelation({...navigation(),resource:true}),
   ...['blocked','fetch_failed'].map(state=>withRelation(navigation('https://outside.example/','nofollow',state))),
   withRelation(navigation('https://outside.example/','nofollow'),r=>{r.pages[0].extraction_truncated=true}),
   withRelation(navigation(),r=>{r.stop_reason='resource_limit'}),
   withRelation(navigation(),r=>{r.pages[0].error='failed'}),
   withRelation(navigation(),r=>{r.pages[0].flags=['extraction_limit']}),
   withRelation(navigation(),r=>{r.outcome='partial'}),
  ]) assert.equal((await summarize(r)).coverage_complete,false,'unexpected unknown targets and genuine partial coverage stay incomplete')
  // Reads upgrade cached version-2 summaries; immutable report and receipt stay intact.
  await db.exec('set role authenticated')
  const detail=(await db.query('select public.seosmith_audit_detail($1,$2) as d',[site,id])).rows[0].d
  const history=(await db.query('select public.seosmith_audit_history($1) as h',[site])).rows[0].h
  assert.equal(detail.summary.summary_version,3);assert.equal(detail.summary.coverage_complete,true)
  assert.deepEqual(history.items[0].summary,detail.summary)
  assert.equal(detail.report_json,raw);assert.deepEqual(detail.report,excluded)
  await db.exec('reset role')
  const storedAfter=(await db.query('select summary,report,raw_report_json,sha256 from public.seosmith_audits where delivery_id=$1',[id])).rows[0]
  assert.deepEqual(storedAfter,storedBefore,'no updates to immutable rows, including cached summaries')
  const latest=structuredClone(excluded);latest.request.request_id='00000000-0000-0000-0000-000000000020'
  await db.query('select public.import_seosmith_audit($1,$2)',[site,JSON.stringify(latest)])
  assert.equal((await db.query('select summary from public.seosmith_audits where delivery_id=$1',[latest.request.request_id])).rows[0].summary.summary_version,3)
  const grants=(await db.query("select has_function_privilege('anon','public.seosmith_navigation_excluded(jsonb,jsonb,jsonb)','execute') as anon,has_function_privilege('authenticated','public.seosmith_navigation_excluded(jsonb,jsonb,jsonb)','execute') as authenticated")).rows[0]
  assert.deepEqual(grants,{anon:false,authenticated:false})
 } finally {await db.close()}
})
