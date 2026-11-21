import { expect, it } from 'vitest'
import { urlHistoryDeltas, type UrlHistoryRow } from '../shared/utils/seosmith-url-history'
const row=(date:string, property_digests:Record<string,string> | null):UrlHistoryRow=>({delivery_id:date,scan_at:date,ingestion_source:'import',evidence_state:'available',schema_version:'2',comparison_key:'key',policy_digest:'digest',engine_version:'engine',ruleset_version:'rules',source_locator:'/pages/0',unknown_reason:null,property_digests})
const old='2026-11-01T00:00:00Z', now='2026-11-02T00:00:00Z'
it('reports observed content and link changes while preserving missing field unknowns',()=>{
 const result=urlHistoryDeltas([row(now,{status:'a',title:'b',links:'d'}),row(old,{status:'a',title:'a',links:'c',body_hash:'x'})])[0]!
 expect(result).toMatchObject({state:'changed',changed:['title','links']});expect(result.unknown).toContain('body_hash')
})
it('does not turn unavailable, omitted, incompatible or tied observations into equality or removal',()=>{
 expect(urlHistoryDeltas([{...row(now,{}),evidence_state:'unavailable'},row(old,{status:'a'})])[0]?.state).toBe('not_observed')
 expect(urlHistoryDeltas([row(now,{status:'a'}),{...row(old,{status:'a'}),policy_digest:'other'}])[0]?.state).toBe('not_observed')
 expect(urlHistoryDeltas([row(now,{status:'a'}),row(now,{status:'b'})])[0]?.state).toBe('not_observed')
 expect(urlHistoryDeltas([row(now,{status:'a'}),row(old,{status:'a'})])[0]).toMatchObject({state:'unchanged_observed',changed:[]})
})
