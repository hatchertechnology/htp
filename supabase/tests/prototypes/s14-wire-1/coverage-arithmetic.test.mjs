// Arithmetic consistency is necessary but explicitly insufficient.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('coverage arithmetic does not prove omitted population state', {skip: !directory && 'Set S14_CANDIDATE_DIR to pinned candidate bundle'},async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x])); const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('coverage-arithmetic.sql',import.meta.url),'utf8'))
  const check=async name=>{const b=await readFile(`${directory}/${name}`);assert.equal(sha(b),entries.get(name).sha256);return db.query('select public.seosmith_candidate_coverage_arithmetic($1)',[JSON.parse(b)])}
  for(const name of ['v4-candidate-complete.json','v4-candidate-mixed-omitted.json']) await check(name)
  for(const name of ['invalid-missing-coverage.json','invalid-negative-count.json']) await assert.rejects(()=>check(name),/invalid_coverage/)
  // Deliberately forged but arithmetically consistent: another independent
  // source-population evaluator MUST reject this before acceptance.
  await check('invalid-omitted-forged-pass.json')
 }finally{await db.close()}
})
