// Independent Node reference for candidate review, not receiver code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const dir=new URL('fixtures/edge-candidate-8d98/',import.meta.url)
const sha=x=>createHash('sha256').update(x).digest('hex')
const count=(map,key)=>{map[key]=(map[key]??0)+1}
function inScope(value,seed) {
  try { const u=new URL(value), base=new URL(seed); return ['http:','https:'].includes(u.protocol) && u.hostname===base.hostname && !u.port && !u.username && !u.password } catch { return false }
}
function parsed(value) { try { new URL(value); return true } catch { return false } }
const entity=p=>'sha256:'+sha(`seosmith-entity-v1\n${p.is_resource?'resource':'page'}\n${p.url}`)
function edgeStates(r) {
 const targets=new Map();for(const p of r.pages) { const xs=targets.get(p.url)??[];xs.push(p);targets.set(p.url,xs) }
 const all=[]
 for(const [i,source] of r.pages.entries()) {
  if(source.is_resource || !inScope(source.url,r.request.url))continue
  for(const [j,link] of source.links.entries()) {
   if(!parsed(link.url) || inScope(link.url,r.request.url))continue
   const matches=targets.get(link.url)??[];if(matches.length>1) throw new Error('ambiguous target')
   const sourceOk=source.status!==null && source.status>=200 && source.status<300 && ['text/html','application/xhtml+xml','application/vnd.wap.xhtml+xml'].includes(source.content_type.split(';')[0].trim().toLowerCase()) && !source.blocked_by_robots && source.error===null && !source.extraction_truncated
   const t=matches[0]
   const reason=!sourceOk?'source_unavailable':!t?(r.request.check_external_links?'external_target_not_fetched':'external_check_disabled'):(t.status===null || t.error!==null || t.blocked_by_robots)?'external_target_unavailable':null
   all.push({candidate:`${entity(source)}|edge:${j}`,context:`/pages/${i}/links/${j}`,outcome:reason?'unknown':'observed',reason,target:t})
  }
 }
 return all
}
test('independent reference reconstructs all edge states including omitted',async()=>{
 const manifest=await readFile(new URL('manifest.json',dir));assert.equal(sha(manifest),'8d98cfcd6f0e0c86fa7cf4eda4df84a71dbf8a7f0768b431529dd28cff57d99d');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x]));const matrix=JSON.parse(await readFile(new URL('edge-cases-candidate.json',dir)))
 for(const fixture of matrix.cases) {
  const bytes=await readFile(new URL(fixture.fixture,dir));assert.equal(bytes.length,entries.get(fixture.fixture).bytes);assert.equal(sha(bytes),entries.get(fixture.fixture).sha256);const r=JSON.parse(bytes)
  if(fixture.expected) {assert.throws(()=>edgeStates(r),/ambiguous target/);continue}
  const all=edgeStates(r), m=r.policy_guidance.manifest.find(x=>x.rule_id==='external_link'), c=r.policy_guidance.candidate.coverage.find(x=>x.rule_id==='external_link'), outcomes={}, reasons={}
  for(const x of all){count(outcomes,x.outcome);if(x.reason)count(reasons,x.reason)}
  assert.deepEqual(m.candidates,all.map(x=>x.candidate));assert.equal(c.candidates,all.length);assert.deepEqual(c.outcomes,outcomes);assert.deepEqual(c.unknown_reasons,reasons)
  const emitted=r.policy_guidance.candidate.records.filter(x=>x.category==='observation' && x.rule_id==='external_link');assert.equal(c.emitted,emitted.length);assert.equal(c.omitted,all.length-emitted.length)
  for(const rec of emitted){const state=all.find(x=>x.context===rec.context_locator);assert.ok(state);assert.equal(rec.outcome,state.outcome);assert.equal(rec.reason,state.reason);if(state.target && !state.reason)assert.equal(rec.observed_fact,state.target.status)}
  if(fixture.omitted!==undefined){assert.equal(c.omitted,fixture.omitted);assert.equal(c.complete,false)}
 }
})
