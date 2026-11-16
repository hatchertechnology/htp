import * as vue from 'vue'
import { useConnectionReload } from '../../app/composables/useConnectionReload'
Object.assign(globalThis, vue, { useConnectionReload })
const { ref, defineComponent, h, createApp } = vue
const provider = ref({connected:false,reauthorizationRequired:false})
const report = ref<any>({ site_url:'https://example.com/', sites: [], sections:{traffic:{rows:[{Date:'2026-10-02',Clicks:2,Impressions:10}],error:null}}, sync:{state:'ready',fetched_at:'2026-10-05T00:00:00Z',connection_status:'disconnected',coverage:{state:'partial',observed_days:1,missing_dates:['2026-10-03']}} })
const ws = {user:ref({id:'fixture-owner'}),selected:ref({fqdn:'example.com'}),selectedId:ref('fixture-site'),bing:provider,request:async()=>report.value}
Object.assign(globalThis, {useWorkspace:()=>ws,useReportRange:()=>({start:ref('2026-10-02'),end:ref('2026-10-03')}),failureMessage:()=> 'Request failed'})
const {default:BingDashboard}=await import('../../app/components/BingDashboard.vue')
const {default:ReportSyncNotice}=await import('../../app/components/ReportSyncNotice.vue')
const app=createApp(BingDashboard)
app.component('ReportSyncNotice',ReportSyncNotice)
for (const name of ['UIcon','UButton','NuxtLink','TrafficChart']) app.component(name,defineComponent({setup(_,{slots}) {return ()=>h('span',slots.default?.())}}))
app.mount('#app')
Object.assign(globalThis, {setFixture: (state: string) => {
  if(state==='failure') report.value={...report.value,sections:{traffic:{rows:[{Date:'2026-10-02',Clicks:2,Impressions:10}],error:'bing_quota_exceeded'}}}
  if(state==='no-match') report.value={...report.value,site_url:'https://example.com/',sites:[],sections:{traffic:{rows:[{Date:'2026-10-02',Clicks:2,Impressions:10}],error:null}}}
  if(state==='rebind') report.value={...report.value,site_url:'https://new.example.com/',sections:{traffic:{rows:[{Date:'2026-10-02',Clicks:99,Impressions:100}],error:null}}}
  provider.value={connected:!provider.value.connected,reauthorizationRequired:false}
}})
