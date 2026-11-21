// Emitted-only experiment: omitted population and production performance remain unverified.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=new URL('fixtures/edge-candidate-8d98/',import.meta.url), sha=b=>createHash('sha256').update(b).digest('hex')
test('candidate emitted edge source and target guards',async()=>{
 const manifest=await readFile(new URL('manifest.json',directory));assert.equal(sha(manifest),'8d98cfcd6f0e0c86fa7cf4eda4df84a71dbf8a7f0768b431529dd28cff57d99d');const entries=new Map(JSON.parse(manifest).files.map(x=>[x.path,x]));const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('edge-check.sql',import.meta.url),'utf8'))
  const check=async name=>{const b=await readFile(new URL(name,directory));assert.equal(b.length,entries.get(name).bytes);assert.equal(sha(b),entries.get(name).sha256);return db.query('select public.seosmith_candidate_emitted_edges($1)',[JSON.parse(b)])}
  for(const name of ['control','source_missing_status','source_non_html','source_non_success','source_error','source_blocked','source_truncated','target_missing_status','target_error','target_blocked']) await check(`v4-candidate-edge-${name}.json`)
  await assert.rejects(()=>check('invalid-ambiguous-external-target.json'),/ambiguous_external_target/)
 }finally{await db.close()}
})
