import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate entity and record identities bind source inventory and policy', {skip: !directory && 'Set S14_CANDIDATE_DIR to pinned candidate bundle'},async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x])); const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('identity-check.sql',import.meta.url),'utf8'))
  const read=async name=>{const b=await readFile(`${directory}/${name}`);assert.equal(sha(b),entries.get(name).sha256);return JSON.parse(b)}
  const check=r=>db.query('select public.seosmith_candidate_identity_check($1)',[r])
  for(const name of ['v4-candidate-complete.json','v4-candidate-omitted.json','v4-candidate-mixed-omitted.json','v4-candidate-reordered.json']) await check(await read(name))
  for(const mutation of [r=>{r.policy_guidance.candidate.records[0].record_id='sha256:forged'},r=>{delete r.policy_guidance.candidate.records[0].record_id},r=>{r.policy_guidance.candidate.records[0].entity_id='sha256:forged'},r=>{r.policy_guidance.candidate.records[0].policy_ref='sha256:forged'},r=>{r.policy_guidance.candidate.records.push(r.policy_guidance.candidate.records[0])},r=>{r.pages.push(r.pages[0])}]) {const r=await read('v4-candidate-complete.json');mutation(r);await assert.rejects(()=>check(r),/invalid_identity|duplicate_record|duplicate_entity/)}
 }finally{await db.close()}
})
