import * as vue from 'vue'
import { useConnectionReload } from '../../app/composables/useConnectionReload'
Object.assign(globalThis, vue, {useConnectionReload})
const {ref, createApp, defineComponent, h} = vue
const ws={ user:ref({id:'owner'}),selectedId:ref('site'),selected:ref({fqdn:'example.com'}),google:ref({connected:true,reauthorizationRequired:false}),request:async (url:string,options:any)=>{
 if(url.endsWith('/properties')) return {properties:[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}]}
 if(url.endsWith('/dashboard')) return {site_url:'sc-domain:example.com',summary:{rows:[]},daily:{rows:[]},queries:{rows:[]},pages:{rows:[]}}
 if(url.endsWith('/crawl-evidence')) { const more=options.body.evaluation_after>=0; return {available:true,coverage:'unknown',scan_at:'2026-10-01T00:00:00Z',ingestion_source:'owner_import',findings:[],findings_has_more:false,next_finding_after:null,evaluations:[{evaluation_locator:more?'/evidence_contract/evaluations/1':'/evidence_contract/evaluations/0',evaluation:more?null:{rule:'title',outcome:'unknown',unknown_reason:'not_attempted',rule_version:'1',validator_version:'2',source_locator:'/pages/0'},evidence_omitted:more}],evaluations_has_more:!more,next_evaluation_after:more?null:0} }
 return {available:false,rows:[],has_more:false}
}}
Object.assign(globalThis,{useRuntimeConfig:()=>({public:{rolloutSearchEvidence:!location.search.includes('held=1')}}),useWorkspace:()=>ws,useReportRange:()=>({start:ref('2026-10-01'),end:ref('2026-10-27')}),failureMessage:()=> 'Request failed'})
const {default:Dashboard}=await import('../../app/components/SearchDashboard.vue')
const app=createApp(Dashboard)
for(const name of ['UIcon','UButton','NuxtLink','TrafficChart','ReportSyncNotice']) app.component(name,defineComponent({setup(_,{slots}) {return ()=>h('span',slots.default?.())}}))
app.component('SearchEvidence', defineComponent({setup() { return () => h('div', {'data-testid':'search-evidence-mounted'}) }}))
app.mount('#app')
