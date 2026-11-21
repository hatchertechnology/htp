// Candidate-only harness. This never installs a migration or advertises schema 4.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const directory = process.env.S14_CANDIDATE_DIR
const digest = data => createHash('sha256').update(data).digest('hex')
test('candidate raw preflight checks lexical schema, decoded duplicates and depth', { skip: !directory && 'Set S14_CANDIDATE_DIR to the pinned candidate bundle' }, async () => {
  const manifestBytes = await readFile(`${directory}/manifest.json`)
  assert.equal(digest(manifestBytes), '84770ef31dbc0aee0885cb27bf816b3ce691c6c916a2831801cb97f0901db304')
  const manifest = JSON.parse(manifestBytes)
  const files = new Map()
  for (const entry of manifest.files) {
    const bytes = await readFile(`${directory}/${entry.path}`)
    assert.equal(bytes.length,entry.bytes); assert.equal(digest(bytes),entry.sha256)
    files.set(entry.path,bytes.toString('utf8'))
  }
  const db = new PGlite()
  try {
    await db.exec(await readFile(new URL('../../../migrations/20261116223631_h01_scanner_budget.sql',import.meta.url),'utf8'))
    await db.exec(await readFile(new URL('raw-preflight.sql',import.meta.url),'utf8'))
    const scan = name => db.query('select public.seosmith_check_raw_report($1)',[files.get(name)])
    for (const name of ['v4-candidate-complete.json','v4-candidate-depth64.json','v4-candidate-unicode-short.json']) await scan(name)
    for (const name of ['invalid-duplicate-root.json','invalid-escaped-duplicate-root.json','invalid-escaped-duplicate-nested.json']) await assert.rejects(()=>scan(name),/invalid_or_duplicate_json_keys/)
    for (const name of ['invalid-schema-fraction.json','invalid-schema-exponent.json']) await assert.rejects(()=>scan(name),/invalid_wire_schema_token/)
    await assert.rejects(()=>scan('invalid-depth65.json'),/report_depth_limit/)
    // A JSON string containing duplicate policy keys requires a separate semantic
    // canonical-policy check; passing the raw report scanner is not acceptance.
    await scan('invalid-policy-duplicate-key.json')
  } finally { await db.close() }
})
