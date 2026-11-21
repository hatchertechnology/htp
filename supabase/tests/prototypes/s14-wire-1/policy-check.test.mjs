// Candidate-only partial checks. Passing these does not imply acceptance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR
const sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate policy binding checks are fail closed for selected mutations', { skip: !directory && 'Set S14_CANDIDATE_DIR to the pinned candidate bundle' }, async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304')
 const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x]))
 const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('policy-check.sql',import.meta.url),'utf8'))
  const check=async name=>{const bytes=await readFile(`${directory}/${name}`);assert.equal(sha(bytes),entries.get(name).sha256);return db.query('select public.seosmith_candidate_policy_check($1)',[JSON.parse(bytes)])}
  for(const name of ['v4-candidate-complete.json','v4-candidate-mixed-omitted.json','v4-candidate-unicode-short.json','v4-candidate-unicode-equal.json']) await check(name)
  for(const name of ['invalid-unknown-wire.json','invalid-unknown-config-key.json','invalid-config-boolean-string.json','invalid-policy-duplicate-key.json','invalid-wrong-policy-digest.json']) await assert.rejects(()=>check(name),/invalid_/)
 }finally{await db.close()}
})
