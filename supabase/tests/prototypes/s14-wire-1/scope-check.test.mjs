// Candidate-only pure scope checks; does not authenticate callers or accept reports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate scope uses trusted source and preserves unverified imports', {skip: !directory && 'Set S14_CANDIDATE_DIR to the pinned candidate bundle'},async()=>{
 const bytes=await readFile(`${directory}/manifest.json`);assert.equal(sha(bytes),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const entries=new Map(JSON.parse(bytes).files.map(x=>[x.path,x]));const db=new PGlite(), site='00000000-0000-4000-8000-000000000002'
 try {
  await db.exec(await readFile(new URL('scope-check.sql',import.meta.url),'utf8'))
  const check=async(name,source,website=site,generation=1)=>{const data=await readFile(`${directory}/${name}`);assert.equal(sha(data),entries.get(name).sha256);return (await db.query('select public.seosmith_candidate_scope_check($1,$2,$3,$4) as scope',[JSON.parse(data),source,website,generation])).rows[0].scope}
  assert.equal(await check('v4-candidate-complete.json','worker'),'verified')
  for(const n of ['v4-candidate-generation-0.json','v4-candidate-generation-2.json']) await assert.rejects(()=>check(n,'worker'),/invalid_worker_scope/)
  await assert.rejects(()=>check('v4-candidate-complete.json','worker','00000000-0000-4000-8000-000000000003'),/invalid_worker_scope/)
  for(const n of ['v4-candidate-generation-0.json','v4-candidate-generation-2.json','v4-candidate-forged-source-claim.json']) assert.equal(await check(n,'import'),'unverified')
 }finally{await db.close()}
})
