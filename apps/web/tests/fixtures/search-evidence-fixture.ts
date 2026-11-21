import * as vue from 'vue'
Object.assign(globalThis, vue)
const { createApp } = vue
Object.assign(globalThis, { useWorkspace: () => ({ request: async (_url: string, options: any) => {
  const { dataset, device, country, offset } = options.body
  if (dataset === 'query_page_segments') return {available:true,rows:device === 'MOBILE' && country === 'usa' ? [{keys:['cleaning','https://example.com/','MOBILE','usa'],clicks:1,impressions:100,ctr:0.01,position:3}] : [],retained_rows:1,has_more:false,collection:{truncated:true},sync:{snapshot_id:42,fetched_at:'2026-11-01T12:00:00Z',state:'stale'}}
  if (dataset === 'analysis') return {available:false,reason:'dataset_unavailable',rows:[],has_more:false}
  return {available:true,rows:offset ? [] : [{keys:['cleaning'],clicks:1,impressions:100,ctr:0.01,position:3}],retained_rows:1,has_more:false,collection:{truncated:false},sync:{snapshot_id:42,fetched_at:'2026-11-01T12:00:00Z',state:'stale'}}
}}), failureMessage: () => 'Request failed' })
const { default: SearchEvidence } = await import('../../app/components/SearchEvidence.vue')
createApp(SearchEvidence, {websiteId:'fixture',property:'sc-domain:example.com',start:'2026-10-01',end:'2026-10-28'}).mount('#app')
