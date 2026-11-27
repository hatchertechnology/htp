import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareIndependent, pageEntityId } from '../shared/utils/independent-audit.ts'
const original = JSON.parse(readFileSync(new URL('./fixtures/comparison-s4/crawl.json', import.meta.url)))
const url = 'https://fixture.invalid/'
const row = [{ url, rule: 'missing_title', state: 'absent' }]
const result = r => compareIndependent(row, r, true, 's15-metadata-3')[0].seosmith
const clone = () => structuredClone(original)
test('page proof rejects incomplete and ambiguous populations', () => {
  assert.equal(result(clone()), 'absent')
  for (const change of [
    r => { r.evidence_contract.coverage.find(c => c.rule === 'missing_title').entities++ },
    r => { r.pages[1].url = r.pages[0].url },
    r => { delete r.pages[1].is_resource },
    r => { r.evidence_contract.omitted_observations++ },
    r => { r.evidence_contract.evaluations = r.evidence_contract.evaluations.filter(e => !(e.entity_id === pageEntityId(r.pages[1].url) && e.rule === 'missing_title')) },
    r => { r.evidence_contract.evaluations.find(e => e.entity_id === pageEntityId(r.pages[1].url) && e.rule === 'missing_title').outcome = 'unknown' },
    r => { const e = r.evidence_contract.evaluations.find(e => e.entity_id === pageEntityId(url) && e.rule === 'missing_title'); r.evidence_contract.evaluations.push(e) },
  ]) { const r = clone(); change(r); assert.equal(result(r), 'unknown') }
})
test('resource unknowns and truncation do not prevent a proven page absence', () => {
  const r = clone(); const resource = { url: 'https://fixture.invalid/image', is_resource: true }
  r.pages.push(resource); r.evidence_contract.coverage.find(c => c.rule === 'missing_title').entities++
  r.evidence_contract.omitted_observations++; r.evidence_contract.truncated = true
  r.evidence_contract.coverage.find(c => c.rule === 'missing_title').unknown++
  assert.equal(result(r), 'absent')
  assert.equal(compareIndependent(row, r, true, 's15-metadata-2')[0].seosmith, 'unknown')
  r.pages.push({ url: 'https://fixture.invalid/after-cap', is_resource: false })
  r.evidence_contract.coverage.find(c => c.rule === 'missing_title').entities++
  r.evidence_contract.omitted_observations++
  assert.equal(result(r), 'unknown')
})
