// The expected registry is pinned in SQL, never supplied by the incoming report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate registry is fixed and cannot be producer-redefined', {skip: !directory && 'Set S14_CANDIDATE_DIR to pinned candidate bundle'},async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x])); const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('registry-check.sql',import.meta.url),'utf8'))
  const check=async name=>{const b=await readFile(`${directory}/${name}`);assert.equal(sha(b),entries.get(name).sha256);return db.query('select public.seosmith_candidate_registry_check($1)',[JSON.parse(b)])}
  for(const name of ['v4-candidate-complete.json','v4-candidate-mixed-omitted.json','v4-candidate-unicode-short.json']) await check(name)
  for(const name of ['invalid-duplicate-manifest-row.json','invalid-missing-manifest.json']) await assert.rejects(()=>check(name),/invalid_registry/)
  const forged=JSON.parse(await readFile(`${directory}/v4-candidate-complete.json`));forged.policy_guidance.catalog[0].confidence='invented';await assert.rejects(()=>db.query('select public.seosmith_candidate_registry_check($1)',[forged]),/invalid_registry/)
 }finally{await db.close()}
})
