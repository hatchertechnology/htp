import { expect, it } from 'vitest'
import { lifecycleHistory, urlPropertyChanges } from '../shared/utils/seosmith-lifecycle'
import type { AuditDetail, AuditEvaluation, AuditPage } from '../shared/types/seosmith'

const evaluation = (outcome: 'fail' | 'pass' | 'unknown', entity_id = 'entity'): AuditEvaluation => ({ entity_id, rule: 'missing_title', rule_version: '1', validator_version: '1', eligibility: outcome === 'unknown' ? 'unknown' : 'eligible', attempt: outcome === 'unknown' ? 'not_attempted' : 'completed', outcome, unknown_reason: outcome === 'unknown' ? 'source_unavailable' : null, source_locator: outcome === 'fail' ? '/findings/0' : '/pages/0', actual: { state: 'known', value: '' }, expected: { state: 'unavailable', reason: 'unknown' }, confidence: outcome === 'unknown' ? 'unknown' : 'high', finding_key: outcome === 'fail' ? 'key' : null })
const run = (id: string, evaluationValue?: AuditEvaluation, evidence = 'missing'): AuditDetail => ({ delivery_id: id, scan_at: `2026-11-${id}T00:00:00Z`, received_at: `2026-11-${id}T00:00:00Z`, ingestion_source: 'worker', summary: { schema_version: 2, engine_version: 'engine', ruleset_version: 'rules', comparison_key: 'digest', coverage_complete: false, evaluation_coverage_complete: false, outcome: 'partial' }, report: { pages: [], request: {}, findings: evaluationValue?.outcome === 'fail' ? [{ key: 'key', rule: 'missing_title', url: 'https://example.com/', severity: 'warning', evidence }] : [], evidence_contract: { version: 1, comparison_key: 'digest', policy: { signature: 'digest', canonical_json: '{}' }, evaluations: evaluationValue ? [evaluationValue] : [], observations: [], coverage: [{ rule: 'missing_title', entities: 1, attempted: evaluationValue?.outcome === 'unknown' ? 0 : 1, unknown: evaluationValue?.outcome === 'unknown' ? 1 : 0, ineligible: 0, eligibility_unknown: evaluationValue?.outcome === 'unknown' ? 1 : 0 }], truncated: false, omitted_observations: 0, evaluation_coverage_complete: false } } } as unknown as AuditDetail)
it('uses explicit per-check evidence even in partial runs and retains baseline provenance', () => {
  const result = lifecycleHistory([run('01', evaluation('fail')), run('02', evaluation('pass'))])!
  expect(result.entries[0]).toMatchObject({ state: 'resolved', source_delivery_id: '01', source_locator: '/findings/0', first_observed: run('01').scan_at, last_observed: run('01').scan_at })
  expect(result.baseline_id).toBe('01')
  expect(result.coverage[0]).toMatchObject({ entities: 1, attempted: 1, excluded: 0 })
})
it('does not infer a pass or a new finding from omitted or unknown evaluations', () => {
  for (const value of [undefined, evaluation('unknown')]) {
    expect(lifecycleHistory([run('01', evaluation('fail')), run('02', value)])!.entries[0]?.state).toBe('not_observed')
    expect(lifecycleHistory([run('01', value), run('02', evaluation('fail'))])!.entries[0]?.state).toBe('not_observed')
  }
})
it('distinguishes changed, persistent, new and reopened findings', () => {
  expect(lifecycleHistory([run('01', evaluation('fail')), run('02', evaluation('fail'))])!.entries[0]?.state).toBe('persisting')
  expect(lifecycleHistory([run('01', evaluation('fail')), run('02', evaluation('fail'), 'different')])!.entries[0]?.state).toBe('changed')
  expect(lifecycleHistory([run('01', evaluation('pass')), run('02', evaluation('fail'))], undefined, true)!.entries[0]?.state).toBe('new')
  expect(lifecycleHistory([run('01', evaluation('fail')), run('02', evaluation('pass')), run('03', evaluation('fail'))])!.entries[0]).toMatchObject({ state: 'reopened', first_observed: run('01').scan_at, last_observed: run('03').scan_at })
})
it('rejects mismatched policy, version and order, and does not compare changed validator versions', () => {
  const old = run('01', evaluation('fail')), next = run('02', evaluation('pass'))
  next.summary.comparison_key = 'different'; expect(lifecycleHistory([old, next])).toBeNull()
  next.summary.comparison_key = 'digest'; next.report.evidence_contract!.version = 2 as 1; expect(lifecycleHistory([old, next])).toBeNull()
  next.report.evidence_contract!.version = 1; expect(lifecycleHistory([next, old])).toBeNull()
  next.report.evidence_contract!.evaluations[0]!.validator_version = '2'; expect(lifecycleHistory([old, next])!.entries[0]?.state).toBe('not_observed')
})
it('compares only properties available in both usable URL observations', () => {
  const a = { url: 'https://example.com/', status: 200, error: null, blocked_by_robots: false, content_type: 'text/html', title: 'A', body_hash: 'x' } as AuditPage
  const b = { ...a, title: 'B', body_hash: undefined }
  expect(urlPropertyChanges(a, b)).toEqual([{ property: 'title', before: 'A', current: 'B' }])
  expect(urlPropertyChanges(a, { ...b, error: 'failed' })).toEqual([])
})
it('reports unavailable URL observations instead of inferring removal', () => {
  const before = run('01', evaluation('fail')), after = run('02', evaluation('pass'))
  before.report.pages = [{ url: 'https://example.com/', status: 200, error: null, blocked_by_robots: false, content_type: 'text/html', title: 'A' } as AuditPage]
  after.report.pages = [{ ...before.report.pages[0]!, title: 'B' }]
  before.report.evidence_contract!.observations = [{ entity_id: 'entity', source_locator: '/pages/0', state: 'available', unknown_reason: null }]
  after.report.evidence_contract!.observations = [{ entity_id: 'entity', source_locator: '/pages/0', state: 'available', unknown_reason: null }]
  expect(lifecycleHistory([before, after])!.urls[0]).toMatchObject({ state: 'changed', properties: [{ property: 'title', before: 'A', current: 'B' }] })
  after.report.evidence_contract!.observations = []
  expect(lifecycleHistory([before, after])!.urls[0]).toMatchObject({ state: 'not_observed', current_locator: null })
})
it('allows an explicit older baseline while retaining the intervening observation window', () => {
  const result = lifecycleHistory([run('01', evaluation('pass')), run('02', evaluation('fail')), run('03', evaluation('pass')), run('04', evaluation('fail'))], '01')!
  expect(result.baseline_id).toBe('01')
  expect(result.entries[0]).toMatchObject({ state: 'reopened', first_observed: run('02').scan_at, last_observed: run('04').scan_at })
  expect(lifecycleHistory([run('01', evaluation('pass')), run('02', evaluation('fail'))], 'missing')).toBeNull()
})
it('retains earlier issues when later checks pass or are unavailable', () => {
  const first = run('01', evaluation('fail')), pass = run('02', evaluation('pass'))
  expect(lifecycleHistory([first, pass, run('03', evaluation('pass'))])!.entries[0]).toMatchObject({ state: 'resolved', source_delivery_id: '01' })
  expect(lifecycleHistory([first, pass, run('03', evaluation('unknown'))])!.entries[0]).toMatchObject({ state: 'not_observed', source_delivery_id: '01' })
})
it('does not infer content changes from error responses', () => {
  const before = { url: 'https://example.com/', status: 200, content_type: 'text/html', error: null, blocked_by_robots: false, title: 'Old' } as AuditPage
  const after = { ...before, status: 404, title: '' }
  expect(urlPropertyChanges(before, after).map(x => x.property)).toEqual(['status'])
})
it('reads retained producer fixtures without turning unknown coverage into passes', async () => {
  const { readFile } = await import('node:fs/promises')
  const report = JSON.parse(await readFile(new URL('../../../supabase/tests/fixtures/contracts/v2-partial.json', import.meta.url), 'utf8'))
  const a = run('01'), b = run('02')
  for (const r of [a, b]) { r.report = report; r.summary.engine_version = report.engine_version; r.summary.ruleset_version = report.ruleset_version; r.summary.comparison_key = report.evidence_contract.comparison_key }
  const result = lifecycleHistory([a, b])!
  expect(result.coverage.some(c => c.unknown > 0)).toBe(true)
  expect(result.entries.some(e => e.state === 'resolved')).toBe(false)
})

it('rejects tied instants for both finding and URL comparisons', () => {
  const a=run('01',evaluation('fail')), b=run('02',evaluation('pass'))
  b.scan_at=a.scan_at
  a.report.pages=[{url:'https://example.com/',status:200,error:null,blocked_by_robots:false,content_type:'text/html',title:'old'} as AuditPage]
  b.report.pages=[{...a.report.pages[0]!,title:'new'}]
  a.report.evidence_contract!.observations=[{entity_id:'entity',source_locator:'/pages/0',state:'available',unknown_reason:null}]
  b.report.evidence_contract!.observations=[{entity_id:'entity',source_locator:'/pages/0',state:'available',unknown_reason:null}]
  expect(lifecycleHistory([a,b])).toBeNull()
})
it('withholds new when earlier history is truncated, unknown or version-incompatible', () => {
  const pass=run('02',evaluation('pass')), fail=run('03',evaluation('fail'))
  expect(lifecycleHistory([pass,fail])!.entries[0]?.state).toBe('not_observed')
  expect(lifecycleHistory([run('01',evaluation('unknown')),pass,fail],undefined,true)!.entries[0]?.state).toBe('not_observed')
  expect(lifecycleHistory([run('01'),pass,fail],undefined,true)!.entries[0]?.state).toBe('not_observed')
  const old=run('01',evaluation('pass'));old.report.evidence_contract!.evaluations[0]!.validator_version='other'
  expect(lifecycleHistory([old,pass,fail],undefined,true)!.entries[0]?.state).toBe('not_observed')
})
it('does not infer a change or persistence when a failure has missing source evidence', () => {
  const a=run('01',evaluation('fail')), b=run('02',evaluation('fail'))
  a.report.findings=[];b.report.findings=[]
  expect(lifecycleHistory([a,b])!.entries[0]?.state).toBe('not_observed')
  b.report.findings=run('02',evaluation('fail')).report.findings
  expect(lifecycleHistory([a,b])!.entries[0]?.state).toBe('not_observed')
})
it('does not compare invalid HTTP status values and includes observed graph and content fields', () => {
  const a={url:'https://example.com/',status:200,error:null,blocked_by_robots:false,content_type:'text/html',headings:[[1,'Old']],images:[],body_hash:'a'} as AuditPage
  const b={...a,headings:[[1,'New']],images:[{url:'https://example.com/a.png',alt:null,width:true,height:true}],body_hash:'b'} as AuditPage
  expect(urlPropertyChanges(a,b).map(x=>x.property)).toEqual(['body_hash','headings','images'])
  expect(urlPropertyChanges(a,{...b,status:999})).toEqual([])
})
it('retains missing attempt metadata as unavailable rather than zero', () => {
  const result=lifecycleHistory([run('01',evaluation('fail')),run('02',evaluation('pass'))])!
  expect(result.coverage[0]).toMatchObject({not_attempted:null,attempt_unknown:null})
  const current=run('02',evaluation('pass'));current.report.evidence_contract!.coverage[0]!.not_attempted=3;current.report.evidence_contract!.coverage[0]!.attempt_unknown=4
  expect(lifecycleHistory([run('01',evaluation('fail')),current])!.coverage[0]).toMatchObject({not_attempted:3,attempt_unknown:4})
})
