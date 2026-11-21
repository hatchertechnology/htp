import * as vue from 'vue'
Object.assign(globalThis, vue)
const { ref, createApp, defineComponent, h } = vue
const entity = 'entity', rule = 'missing_title'
function run(id: string, outcome: 'fail' | 'pass') {
  const date = `2026-11-${id}T00:00:00Z`, key = 'same', finding = { key: 'finding', rule, url: 'https://example.com/', severity: 'warning', evidence: 'missing' }
  return { delivery_id: id, scan_at: date, received_at: date, ingestion_source: 'worker', summary: { schema_version: 2, engine_version: 'engine', ruleset_version: 'rules', comparison_key: key, coverage_complete: false, outcome: 'partial', stop_reason: 'page_limit', pages: {checked:1,html:1,images:0,http_errors:0,fetch_errors:0,blocked:0}, severities: {critical:0,alert:0,warning:1}, findings: 1, finished_at: date, rules: {} }, report: { request: {max_pages:10}, pages: [{url:'https://example.com/',status:200,content_type:'text/html',title: outcome === 'pass' ? 'Title' : '',error:null,blocked_by_robots:false,bytes:0,ttfb_ms:0}], findings: outcome === 'fail' ? [finding] : [], evidence_contract: {version:1,comparison_key:key,policy:{signature:key,canonical_json:'{}'},observations:[{entity_id:entity,source_locator:'/pages/0',state:'available',unknown_reason:null}],evaluations:[{entity_id:entity,rule,rule_version:'1',validator_version:'1',eligibility:'eligible',attempt:'completed',outcome,source_locator:outcome === 'fail' ? '/findings/0' : '/pages/0',finding_key:outcome === 'fail' ? 'finding' : null}],coverage:[{rule,entities:1,attempted:1,unknown:0,ineligible:0,eligibility_unknown:0}],truncated:false,omitted_observations:0,evaluation_coverage_complete:false} } }
}
const older=run('01','fail'), current=run('02','pass')
const ws = { user: ref({id:'owner'}), selected: ref({fqdn:'example.com'}), selectedId: ref('site'), request: async () => older }
Object.assign(globalThis, { useWorkspace: () => ws, failureMessage: () => 'Request failed', useSeosmith: () => ({runs: ref([current,older]), selected: ref(current), busy: ref(false), detailBusy: ref(false), importing: ref(false), error: ref(''), notice: ref(''), cursor: ref(null), load: async()=>{}, select: async()=>{}, importFile: async()=>{}}) })
const { default: Dashboard } = await import('../../app/components/SeosmithDashboard.vue')
const app=createApp(Dashboard)
for (const name of ['UIcon','SeosmithTrend']) app.component(name, defineComponent({setup(_,{slots}) { return () => h('span',slots.default?.()) }}))
app.mount('#app')
