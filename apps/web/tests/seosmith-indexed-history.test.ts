import { expect, it } from 'vitest'
import { indexedTransitions, type IndexedHistoryRow } from '../shared/utils/seosmith-indexed-history'
let seq=0
const row=(outcome: string, digest: string | null = 'same'): IndexedHistoryRow => ({delivery_id:'id',ingestion_source:'worker',scan_at:new Date(Date.UTC(2026,10,20,0,0,0,1000-(seq++))).toISOString(),evidence_state:'evaluated',comparison_key:'k',schema_version:'2',engine_version:'e',ruleset_version:'r',policy_digest:'p',evaluation:{outcome,eligibility:'eligible',attempt:'completed',rule_version:'r',validator_version:'v',source_locator:'/findings/0',finding_digest:digest}})
it('classifies explicit adjacent outcomes and preserves unknown gaps',()=>{
 expect(indexedTransitions([row('pass'),row('fail')],false)).toEqual(['resolved','not_observed'])
 expect(indexedTransitions([row('fail'),row('fail')],false)[0]).toBe('persisting')
 expect(indexedTransitions([row('fail','b'),row('fail','a')],false)[0]).toBe('changed')
 expect(indexedTransitions([row('fail'),row('pass')],false)[0]).toBe('new')
 expect(indexedTransitions([row('fail'),row('pass'),row('fail')],false)[0]).toBe('reopened')
 expect(indexedTransitions([row('fail'),row('pass')],true)[0]).toBe('not_observed')
 const missing={...row('pass'),evidence_state:'index_pending',evaluation:null}
 expect(indexedTransitions([row('fail'),missing],false)[0]).toBe('not_observed')
 expect(indexedTransitions([row('fail'),row('pass'),missing],false)[0]).toBe('not_observed')
})
it('requires compatible policy, validator and digest before a transition',()=>{
 expect(indexedTransitions([row('fail'),{...row('pass'),policy_digest:'different'}],false)[0]).toBe('not_observed')
 expect(indexedTransitions([row('fail',null),row('fail')],false)[0]).toBe('not_observed')
 const changed=row('pass');changed.evaluation!.validator_version='different'
 expect(indexedTransitions([row('fail'),changed],false)[0]).toBe('not_observed')
})

it('classifies schema-4 history and keeps the 2/4 boundary unobserved',()=>{
 expect(indexedTransitions([{...row('pass'),schema_version:'4'},{...row('fail'),schema_version:'4'}],false)).toEqual(['resolved','not_observed'])
 expect(indexedTransitions([{...row('fail'),schema_version:'4'},{...row('fail'),schema_version:'4'}],false)[0]).toBe('persisting')
 expect(indexedTransitions([{...row('fail'),schema_version:'4'},{...row('pass'),schema_version:'4'}],false)[0]).toBe('new')
 expect(indexedTransitions([{...row('fail'),schema_version:'4'},{...row('pass'),schema_version:'2'}],false)).toEqual(['not_observed','not_observed'])
 expect(indexedTransitions([{...row('fail'),schema_version:'2'},{...row('pass'),schema_version:'4'}],false)).toEqual(['not_observed','not_observed'])
})
it('does not infer ordering from tied scan times',()=>{ const a=row('fail'), b={...row('pass'),scan_at:a.scan_at}; expect(indexedTransitions([a,b],false)[0]).toBe('not_observed') })
