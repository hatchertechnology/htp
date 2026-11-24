import * as vue from 'vue'
const {ref,defineComponent,h,createApp} = vue
// Synthetic identifiers only. No real owner, site, host, token or hosted endpoint is used.
const SITE='10000000-0000-0000-0000-000000000001'
const FORM='10000000-0000-0000-0000-000000000002'
const HOST='30000000-0000-0000-0000-000000000001'
const NEW_HOST='30000000-0000-0000-0000-000000000002'
const NEW_FORM='10000000-0000-0000-0000-000000000003'
const TOKEN='b'.repeat(64)
const form={id:FORM,name:'Cleaning Quote',form_key:'cleaning_quote',active:true,fields:[{key:'name',label:'Name',kind:'text',required:true,max_length:100}]}
const data:Record<string,any[]>={website_form_hosts:[{id:HOST,hostname:'www.example.com',verified_at:'2026-01-01'}],website_forms:[form],website_form_responses:[{id:'40000000-0000-0000-0000-000000000001',status:'new',received_at:'2026-01-01',values:{name:'<script>unsafe</script>'}}],website_form_origins:[{form_id:FORM,host_id:HOST}],website_form_recipients:[{id:'recipient-id',email:'fixture@example.invalid',verified_at:'2026-01-01',enabled:true}],website_form_delivery_jobs:[{id:'job-id',recipient_id:'recipient-id',response_id:'40000000-0000-0000-0000-000000000001',kind:'response',state:'failed',attempts:1}]}
const params=new URLSearchParams(location.search), mode=params.get('mode')==='pilot'?'pilot':'legacy', visibility=params.get('eligible') ?? 'yes'
const staticMode=params.get('static')==='1'
const user=ref<{id:string;is_anonymous?:boolean}|null>({id:'owner'}), calls:string[]=[], queries:string[]=[], apiCalls:string[]=[], bodies:{method:string;path:string;body:any}[]=[]
// One-shot failure injection for the static owner API. `applied` commits the write, then loses the response.
type Injected={route:string;code?:string;applied:boolean}
let nextFailure:Injected|null=null
let issuedToken=''
let challengeError = ''
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const eligibleValue=()=>visibility==='yes'||visibility==='slow'
const supabase={from(table:string) { queries.push(table);const query:any={select:()=>query,eq:()=>query,in:()=>query,order:()=>query,range:()=>query,then:(resolve:(value:unknown)=>void)=>resolve({data:data[table] ?? [],error:null})};return query },rpc:async(name:string)=>{calls.push(name);return {data:name==='begin_form_host_verification'?{host_id:HOST,txt_name:'_htp-verification.example.test',txt_value:'htp-verification='+ 'a'.repeat(64)}:true,error:name==='begin_form_host_verification'&&challengeError?{message:challengeError}:null}},functions:{invoke:async(name:string)=>{calls.push(name);return {data:{ok:true},error:null}}}}
function takeFailure(route:string):Injected|null{
  if(!nextFailure||nextFailure.route!==route) return null
  const injected=nextFailure; nextFailure=null
  return injected
}
function failureError(injected:Injected){ return Object.assign(new Error('fixture transport failure'), injected.code?{data:{code:injected.code}}:{}) }
function pageOf(items:any[]){return {items,has_more:false}}
// Local stand-in for the HTP owner API. The page-level wrapper records every method, path, query and body.
async function apiFetch(target:URL, method:string, body:any){
  const path=target.pathname
  if(path===`/websites/${SITE}/forms/pilot-eligibility`){ if(visibility==='slow') await delay(500); return {eligible:eligibleValue()} }
  if(path===`/websites/${SITE}/forms/hosts`) return pageOf(data.website_form_hosts)
  if(path===`/websites/${SITE}/forms/origins`){ const formId=target.searchParams.get('form_id'); return pageOf(data.website_form_origins.filter(row=>!formId||row.form_id===formId)) }
  if(path===`/websites/${SITE}/forms`&&method==='GET') return pageOf(data.website_forms)
  if(path===`/websites/${SITE}/forms`&&method==='POST'){
    const failed=takeFailure('save'); if(failed) throw failureError(failed)
    const existing=body.form_id?data.website_forms.find(row=>row.id===body.form_id):null
    if(body.form_id&&!existing) throw Object.assign(new Error('fixture not found'),{data:{code:'not_found'}})
    const saved={id:existing?.id??NEW_FORM,form_key:body.form_key,name:body.name,fields:body.fields,active:body.active}
    if(existing) Object.assign(existing,saved); else data.website_forms.push({...saved})
    return saved
  }
  if(path===`/websites/${SITE}/forms/host-verifications`&&method==='POST'){
    const failed=takeFailure('begin'); if(failed) throw failureError(failed)
    if(body.hostname!=='www.example.com') throw Object.assign(new Error('fixture refusal'),{data:{code:'invalid_request'}})
    if(!data.website_form_hosts.some(row=>row.id===NEW_HOST)) data.website_form_hosts.push({id:NEW_HOST,hostname:body.hostname,verified_at:null})
    issuedToken=TOKEN
    return {host_id:NEW_HOST,hostname:body.hostname,txt_name:`_htp-verification.${body.hostname}`,txt_value:`htp-verification=${issuedToken}`,expires_in_hours:24}
  }
  const confirm=/^\/forms\/host-verifications\/([0-9a-f-]+)\/confirm$/i.exec(path)
  if(confirm&&method==='POST'){
    const failed=takeFailure('confirm')
    if(failed&&!failed.applied) throw failureError(failed)
    if(body.token!==issuedToken) throw Object.assign(new Error('fixture refusal'),{data:{code:'invalid_request'}})
    const host=data.website_form_hosts.find(row=>row.id===confirm[1])
    if(!host) throw Object.assign(new Error('fixture not found'),{data:{code:'host_not_found'}})
    host.verified_at='2026-11-24'
    if(failed) throw failureError(failed)
    return {host_id:host.id,verified:true,status:'verified'}
  }
  if(new RegExp(`^/websites/${SITE}/forms/${FORM}/responses$`).test(path)&&method==='GET') return pageOf(data.website_form_responses)
  const response = new RegExp(`^/websites/${SITE}/forms/${FORM}/responses/([0-9a-f-]+)(/status)?$`).exec(path)
  if(response && (method==='PATCH'||method==='DELETE')) {
    const failed=takeFailure('response')
    if(failed&&!failed.applied) throw failureError(failed)
    const row=data.website_form_responses.find(row=>row.id===response[1])
    if(method==='PATCH'&&row) row.status=body.status
    if(method==='DELETE') data.website_form_responses=data.website_form_responses.filter(row=>row.id!==response[1])
    if(failed) throw failureError(failed)
    return method==='PATCH'?{id:response[1],status:body.status}:{id:response[1],deleted:true}
  }
  throw Object.assign(new Error(`fixture has no route for ${method} ${path}`),{data:{code:'not_found'}})
}
const apiOrNitroFetch=async(url:string,options:{method?:string;body?:any}={})=>{
  const method=(options.method??'GET').toUpperCase()
  const target=new URL(String(url),'https://fixture.invalid')
  if(!staticMode){
    // Non-static (Nitro) pilot path: same-origin eligibility only. Owner writes stay on the existing RPC path.
    if(target.pathname==='/api/forms/pilot-eligibility'){ if(visibility==='error') throw new Error('fixture auth failure'); if(visibility==='slow') await delay(500); return {eligible:eligibleValue()} }
    throw new Error(`unexpected non-static request ${target.pathname}`)
  }
  if(visibility==='error') throw new Error('fixture auth failure')
  apiCalls.push(`${method} ${target.pathname}${target.search}`)
  if(options.body!==undefined) bodies.push({method,path:target.pathname,body:JSON.parse(JSON.stringify(options.body))})
  return apiFetch(target,method,options.body)
}
const {default:WebsiteForms}=await import('../../app/components/WebsiteForms.vue')
Object.assign(globalThis,vue,{formFixture:{calls,queries,apiCalls,bodies,setOwner:(id:string|null)=>{user.value=id?{id}:null},setAnonymous:()=>{user.value={id:'owner',is_anonymous:true}},failNext:(route:string,code?:string,applied=false)=>{nextFailure={route,code,applied}},state:()=>({calls:[...calls],queries:[...queries],apiCalls:[...apiCalls],bodies:[...bodies]})},setChallengeError:(value:string)=>{challengeError=value},useNuxtApp:()=>({$supabase:supabase}),useAuth:()=>({user,accessToken:async()=>user.value?'fixture-token':null}),useRuntimeConfig:()=>({public:{supabaseUrl:'https://example.test',apiBaseUrl:'https://api.example.test',staticDashboard:staticMode,rolloutFormsPilot:true,rolloutFormsResponses:params.get('responses')==='1'}}),$fetch:apiOrNitroFetch})
const app=createApp(WebsiteForms,{websiteId:SITE,fqdn:'www.example.com',mode})
app.component('UButton',defineComponent({inheritAttrs:false,setup(_,{slots,attrs}){return()=>h('button',attrs,slots.default?.())}}))
app.mount('#app')
