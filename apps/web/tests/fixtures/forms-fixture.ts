import * as vue from 'vue'
const {ref,defineComponent,h,createApp} = vue
const form={id:'form-id',name:'Cleaning Quote',form_key:'cleaning_quote',active:true,fields:[{key:'name',label:'Name',kind:'text',required:true,max_length:100}]}
const data:Record<string,unknown[]>={website_form_hosts:[{id:'host-id',hostname:'www.example.com',verified_at:'2026-01-01'}],website_forms:[form],website_form_responses:[{id:'response-id',status:'new',received_at:'2026-01-01',values:{name:'<script>unsafe</script>'}}],website_form_origins:[{host_id:'host-id'}]}
const supabase={from(table:string) { const query:any={select:()=>query,eq:()=>query,order:()=>query,range:()=>query,then:(resolve:(value:unknown)=>void)=>resolve({data:data[table] ?? [],error:null})};return query },rpc:async()=>({data:null,error:null}),functions:{invoke:async()=>({data:{ok:true},error:null})}}
Object.assign(globalThis,vue,{useNuxtApp:()=>({$supabase:supabase}),useAuth:()=>({user:ref({id:'owner'})}),useRuntimeConfig:()=>({public:{supabaseUrl:'https://example.test'}})})
const {default:WebsiteForms}=await import('../../app/components/WebsiteForms.vue')
const app=createApp(WebsiteForms,{websiteId:'site-id',fqdn:'www.example.com'})
app.component('UButton',defineComponent({inheritAttrs:false,setup(_,{slots,attrs}){return()=>h('button',attrs,slots.default?.())}}))
app.mount('#app')
