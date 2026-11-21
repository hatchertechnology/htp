import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=process.env.S14_CANDIDATE_DIR, sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate canonical encoding checks exact policy bytes', {skip: !directory && 'Set S14_CANDIDATE_DIR to pinned candidate bundle'},async()=>{
 const manifest=await readFile(`${directory}/manifest.json`);assert.equal(sha(manifest),'84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304');const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('canonical-check.sql',import.meta.url),'utf8'))
  const r=JSON.parse(await readFile(`${directory}/v4-candidate-complete.json`));const raw=r.policy_guidance.candidate.policy_canonical_json
  assert.equal(sha(raw),'366efa070c5875939cc00d423fddcb00c6f57c22051300a49d457c24c0b5e074')
  const check=x=>db.query('select public.seosmith_candidate_canonical_check($1)',[x]);await check(raw)
  await assert.rejects(()=>check(raw.replace('{','{ ')),/noncanonical_policy/)
  await assert.rejects(()=>check('{"x":1,"x":2}'),/invalid_policy_json/)
  await assert.rejects(()=>check('{"x":1.0}'),/invalid_canonical_number|noncanonical_policy/)
  await assert.rejects(()=>check('{"x":9007199254740992}'),/invalid_canonical_number/)
  await check('{"a":"😀","z":"\u2028"}')
  await check(String.raw`{"x":"\b\t\n\f\r\u0001\"\\/"}`)
  await check('{"":1,"𐀀":2}')
  await assert.rejects(()=>check('{"𐀀":2,"":1}'),/noncanonical_policy/)
  await assert.rejects(()=>check('{"x":-0}'),/noncanonical_policy|invalid_canonical_number/)
  await assert.rejects(()=>check('{"x":1e0}'),/noncanonical_policy|invalid_canonical_number/)
 }finally{await db.close()}
})
