// These are raw preflight vectors, not valid full closed policies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory=new URL('fixtures/policy-raw-203b/',import.meta.url), sha=b=>createHash('sha256').update(b).digest('hex')
test('embedded policy raw scanner observes inclusive byte and depth limits',async()=>{
 const bytes=await readFile(new URL('manifest.json',directory));assert.equal(sha(bytes),'203b15565df3c9ef68de21a8b85f1a6cd8fecab545f0e241885f0d8e46f90e63');const entries=new Map(JSON.parse(bytes).files.map(x=>[x.path,x]));const matrix=await readFile(new URL('policy-raw-cases-candidate.json',directory));assert.equal(sha(matrix),'84e3c27750781f175d0444ae4ea885061b904564e1d13f6637574bff12b5b4a2');const db=new PGlite()
 try {
  await db.exec(await readFile(new URL('canonical-check.sql',import.meta.url),'utf8'))
  for(const item of JSON.parse(matrix).cases) {
   const raw=await readFile(new URL(item.fixture,directory));assert.equal(raw.length,entries.get(item.fixture).bytes);assert.equal(sha(raw),entries.get(item.fixture).sha256)
   const scan=()=>db.query('select public.seosmith_candidate_policy_raw_preflight($1)',[raw.toString('utf8')])
   if(item.expected==='scanner_accept') await scan();else await assert.rejects(scan,/policy_depth_limit|invalid_policy_json/)
  }
 }finally{await db.close()}
})
