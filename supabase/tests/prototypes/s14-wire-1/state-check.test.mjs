import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate emitted tuples obey the finite state matrix', {skip: !directory && 'Set S14_CANDIDATE_DIR to pinned candidate bundle'},async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x]));const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('state-check.sql',import.meta.url),'utf8'))
  const check=async name=>{const b=await readFile(`${directory}/${name}`);assert.equal(sha(b),entries.get(name).sha256);return db.query('select public.seosmith_candidate_state_check($1)',[JSON.parse(b)])}
  for(const name of ['v4-candidate-complete.json','v4-candidate-mixed-omitted.json','v4-candidate-unicode-short.json','v4-candidate-intent.json']) await check(name)
  await assert.rejects(()=>check('invalid-forged-state.json'),/invalid_state/)
 }finally{await db.close()}
})
