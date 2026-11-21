<script setup lang="ts">
import { csvCell } from "../utils/forms-csv"
type Field = { key: string; label: string; kind: 'text'|'email'|'telephone'|'multiline'; required: boolean; max_length: number }
type Host = { id: string; hostname: string; verified_at: string | null }
type Form = { id: string; form_key: string; name: string; fields: Field[]; active: boolean }
type Recipient = { id:string; email:string; verified_at:string|null; enabled:boolean }
type Delivery = { id:string; recipient_id:string; response_id:string|null; kind:string; state:string; attempts:number }
type Submission = { id: string; received_at: string; status: string; values: Record<string,string> }
const props = defineProps<{ websiteId: string; fqdn: string }>()
const { $supabase } = useNuxtApp()
const auth = useAuth()
const config = useRuntimeConfig()
const expanded = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const hosts = ref<Host[]>([]), forms = ref<Form[]>([]), submissions = ref<Submission[]>([])
const deleting = ref<string|null>(null)
const recipients = ref<Recipient[]>([]), deliveries = ref<Delivery[]>([]), recipientEmail = ref('')
const selected = ref<Form | null>(null), editing = ref<string | null>(null), moreResponses = ref(false)
const hostname = ref(props.fqdn), challenge = ref<{host_id:string;txt_name:string;txt_value:string}|null>(null)
const name = ref(''), formKey = ref(''), enabled = ref(false), chosenHosts = ref<string[]>([])
const fields = ref<Field[]>([{key:'name',label:'Name',kind:'text',required:true,max_length:100},{key:'email',label:'Email',kind:'email',required:true,max_length:254}])
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : 'The request failed. Please try again.' }
function reset() { editing.value=null; name.value=''; formKey.value=''; enabled.value=false; chosenHosts.value=[]; fields.value=[{key:'name',label:'Name',kind:'text',required:true,max_length:100},{key:'email',label:'Email',kind:'email',required:true,max_length:254}] }
async function load() {
  const owner = auth.user.value?.id
  error.value=''
  const [hostResult, formResult] = await Promise.all([
    $supabase.from('website_form_hosts').select('id,hostname,verified_at').eq('website_id',props.websiteId).order('hostname'),
    $supabase.from('website_forms').select('id,form_key,name,fields,active').eq('website_id',props.websiteId).order('name'),
  ])
  if (!owner || auth.user.value?.id !== owner) return
  if (hostResult.error || formResult.error) { error.value='Could not load forms. Please try again.'; return }
  hosts.value=(hostResult.data ?? []) as Host[]; forms.value=(formResult.data ?? []) as Form[]
}
async function begin() {
  busy.value=true; error.value=''; notice.value=''
  try {
    const {data,error:err}=await $supabase.rpc('begin_form_host_verification',{p_website_id:props.websiteId,p_hostname:hostname.value.trim().toLowerCase()})
    if (err) throw err
    challenge.value=data
    await load()
  } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function verify() {
  if (!challenge.value) return
  busy.value=true; error.value=''; notice.value=''
  try {
    const token=challenge.value.txt_value.slice('htp-verification='.length)
    const {data,error:err}=await $supabase.functions.invoke('form-verify',{body:{host_id:challenge.value.host_id,token}})
    if (err || !data?.ok) throw new Error('Could not verify the DNS record yet. Check the value and try again.')
    challenge.value=null; notice.value='Host verified.'; await load()
  } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function edit(form:Form) {
  editing.value=form.id; name.value=form.name; formKey.value=form.form_key; enabled.value=form.active; fields.value=structuredClone(form.fields)
  const {data,error:err}=await $supabase.from('website_form_origins').select('host_id').eq('website_id',props.websiteId).eq('form_id',form.id)
  if (err) { fail(err); return }; chosenHosts.value=(data ?? []).map((row: {host_id:string})=>row.host_id)
}
async function save() {
  busy.value=true; error.value=''; notice.value=''
  try {
    const {error:err}=await $supabase.rpc('save_website_form',{p_website_id:props.websiteId,p_form_id:editing.value,p_form_key:formKey.value,p_name:name.value,p_fields:fields.value,p_active:enabled.value,p_host_ids:chosenHosts.value})
    if (err) throw err
    reset(); await load(); notice.value='Form saved.'
  } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function inbox(form:Form, more = false) {
  const owner = auth.user.value?.id
  if (!more) { selected.value=form; submissions.value=[] }; error.value=''
  const {data,error:err}=await $supabase.from('website_form_responses').select('id,received_at,status,values').eq('website_id',props.websiteId).eq('form_id',form.id).order('received_at',{ascending:false}).order('id').range(submissions.value.length,submissions.value.length + 99)
  if (!owner || auth.user.value?.id !== owner || selected.value?.id !== form.id) return
  if(err) { fail(err); return }; const rows=(data ?? []) as Submission[]; submissions.value.push(...rows); moreResponses.value=rows.length===100
  const result=await $supabase.from('website_form_recipients').select('id,email,verified_at,enabled').eq('website_id',props.websiteId).eq('form_id',form.id)
  if (auth.user.value?.id !== owner || selected.value?.id !== form.id) return
  if (result.error) { fail(result.error); return }
  recipients.value=(result.data ?? []) as Recipient[]
  if (recipients.value.length) {
    const all:Delivery[]=[]
    for (let offset=0; ; offset+=500) {
      const jobs=await $supabase.from('website_form_delivery_jobs').select('id,recipient_id,response_id,kind,state,attempts').in('recipient_id',recipients.value.map(r=>r.id)).order('created_at',{ascending:false}).order('id').range(offset,offset+499)
      if (auth.user.value?.id !== owner || selected.value?.id !== form.id) return
      if (jobs.error) { fail(jobs.error); return }
      all.push(...((jobs.data ?? []) as Delivery[]))
      if (!jobs.data || jobs.data.length<500) break
    }
    deliveries.value=all
  } else deliveries.value=[]
}
async function addRecipient() {
  if (!selected.value) return
  busy.value=true; error.value=''; notice.value=''
  try { const {error:err}=await $supabase.rpc('request_form_recipient',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_email:recipientEmail.value}); if (err) throw err; recipientEmail.value=''; notice.value='Verification email queued.'; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function disableRecipient(recipient:Recipient) {
  if (!selected.value) return
  busy.value=true; error.value=''
  try { const {error:err}=await $supabase.rpc('disable_form_recipient',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_recipient_id:recipient.id}); if(err) throw err; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function retryDelivery(job:Delivery) {
  if (!selected.value) return
  if (job.state === 'uncertain' && !window.confirm('The provider may already have delivered this notification. Resend and risk a duplicate email?')) return
  busy.value=true; error.value=''
  try { const {data,error:err}=await $supabase.rpc('retry_form_delivery',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_job_id:job.id}); if (err || !data) throw new Error('This delivery cannot be retried.'); await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function deleteResponse(row:Submission) {
  if (!selected.value) return
  busy.value=true; error.value=''
  try { const {error:err}=await $supabase.rpc('delete_website_form_response',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_response_id:row.id}); if(err) throw err; deleting.value=null; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function status(row:Submission, next:string) {
  if (!selected.value) return
  busy.value=true; error.value=''
  try { const {error:err}=await $supabase.rpc('set_website_form_response_status',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_response_id:row.id,p_status:next}); if(err) throw err; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function exportCsv() {
  const form=selected.value, owner=auth.user.value?.id
  if (!form || !owner) return
  busy.value=true; error.value=''
  try {
    const rows: Submission[]=[]
    for (let offset=0; ; offset+=500) {
      const {data,error:err}=await $supabase.from('website_form_responses').select('id,received_at,status,values').eq('website_id',props.websiteId).eq('form_id',form.id).order('received_at',{ascending:false}).order('id').range(offset,offset+499)
      if (err) throw err
      if (auth.user.value?.id !== owner) return
      rows.push(...((data ?? []) as Submission[]))
      if (!data || data.length<500) break
    }
    const keys=[...new Set([...form.fields.map(field=>field.key),...rows.flatMap(row=>Object.keys(row.values))])]
    const lines=[['received_at','status',...keys],...rows.map(row=>[row.received_at,row.status,...keys.map(key=>row.values[key] ?? '')])].map(row=>row.map(csvCell).join(','))
    const url=URL.createObjectURL(new Blob([lines.join('\r\n')],{type:'text/csv;charset=utf-8'})); const link=document.createElement('a'); link.href=url; link.download=`${form.form_key}.csv`; link.click(); URL.revokeObjectURL(url)
  } catch(cause) { fail(cause) } finally { busy.value=false }
}
watch(()=>auth.user.value?.id,()=>{ hosts.value=[]; forms.value=[]; submissions.value=[]; recipients.value=[]; deliveries.value=[]; selected.value=null; deleting.value=null; challenge.value=null; reset(); expanded.value=false })
</script>

<template>
  <section class="forms-section" :aria-label="`Forms for ${fqdn}`">
    <UButton color="neutral" variant="ghost" icon="i-lucide-messages-square" @click="expanded = !expanded; if (expanded) load()">{{ expanded ? 'Close forms' : 'Forms' }}</UButton>
    <div v-if="expanded" class="forms-content">
      <h3>Forms and responses</h3>
      <p>Verify each exact host before collecting inquiries. A form can use one or more verified hosts.</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <div class="forms-block">
        <h4>Verify a website host</h4>
        <form @submit.prevent="begin"><label>Hostname <input v-model="hostname" required maxlength="253" placeholder="www.example.com"></label> <UButton type="submit" :loading="busy">Create DNS challenge</UButton></form>
        <div v-if="challenge"><p>Add this TXT record to your DNS, then verify it. The challenge expires after 24 hours.</p><p>Name: <code>{{ challenge.txt_name }}</code></p><p>Value: <code>{{ challenge.txt_value }}</code></p><UButton :loading="busy" @click="verify">Verify DNS record</UButton></div>
        <ul><li v-for="host in hosts" :key="host.id">{{ host.hostname }} — {{ host.verified_at ? 'Verified' : 'Not verified' }}</li></ul>
      </div>
      <div class="forms-block">
        <h4>{{ editing ? 'Edit form' : 'Create a form' }}</h4>
        <form @submit.prevent="save">
          <label>Form name <input v-model="name" required maxlength="100"></label>
          <label>Form key <input v-model="formKey" required pattern="[a-z][a-z0-9_]{0,63}" placeholder="cleaning_quote"></label>
          <fieldset><legend>Fields</legend>
            <div v-for="(field,index) in fields" :key="index" class="forms-field">
              <label>Key <input v-model="field.key" required pattern="[a-z][a-z0-9_]{0,63}"></label>
              <label>Label <input v-model="field.label" required maxlength="100"></label>
              <label>Type <select v-model="field.kind"><option value="text">Text</option><option value="email">Email</option><option value="telephone">Telephone</option><option value="multiline">Multiline text</option></select></label>
              <label>Maximum characters <input v-model.number="field.max_length" type="number" min="1" max="5000" required></label>
              <label><input v-model="field.required" type="checkbox"> Required</label>
              <UButton type="button" color="neutral" variant="ghost" :disabled="fields.length === 1" @click="fields.splice(index,1)">Remove field</UButton>
            </div>
            <UButton type="button" color="neutral" variant="outline" :disabled="fields.length >= 32" @click="fields.push({key:'',label:'',kind:'text',required:false,max_length:500})">Add field</UButton>
          </fieldset>
          <fieldset><legend>Permitted verified hosts</legend><label v-for="host in hosts.filter(h=>h.verified_at)" :key="host.id"><input v-model="chosenHosts" type="checkbox" :value="host.id"> {{ host.hostname }} </label><p v-if="!hosts.some(h=>h.verified_at)">Verify a host before activating a form.</p></fieldset>
          <label><input v-model="enabled" type="checkbox"> Accept submissions</label>
          <div><UButton type="submit" :loading="busy">Save form</UButton> <UButton v-if="editing" type="button" color="neutral" variant="outline" @click="reset">Cancel edit</UButton></div>
        </form>
      </div>
      <div class="forms-block"><h4>Your forms</h4><p v-if="!forms.length">No forms yet.</p><ul><li v-for="form in forms" :key="form.id"><strong>{{ form.name }}</strong> — {{ form.active ? 'Active' : 'Paused' }} <UButton color="neutral" variant="ghost" @click="edit(form)">Edit</UButton><UButton color="neutral" variant="ghost" @click="inbox(form)">Responses</UButton><p>Submission endpoint: <code>{{ config.public.supabaseUrl }}/functions/v1/form-submit?form={{ form.id }}</code></p></li></ul></div>
      <div v-if="selected" class="forms-block"><h4>Notification recipients</h4><p>Each recipient must confirm their address before inquiries are sent. Delivery status records whether the email provider accepted the message.</p><form @submit.prevent="addRecipient"><label>Email address <input v-model="recipientEmail" type="email" required maxlength="254"></label><UButton type="submit" :loading="busy">Send verification</UButton></form><ul><li v-for="recipient in recipients" :key="recipient.id">{{ recipient.email }} — {{ !recipient.enabled ? 'Disabled' : recipient.verified_at ? 'Verified' : 'Awaiting verification' }} <UButton v-if="recipient.enabled" color="neutral" variant="ghost" @click="disableRecipient(recipient)">Disable</UButton><ul><li v-for="job in deliveries.filter(item => item.recipient_id === recipient.id && item.kind === 'verification')" :key="job.id">Verification: {{ job.state }} <UButton v-if="job.state === 'failed'" color="neutral" variant="ghost" @click="retryDelivery(job)">Retry</UButton><span v-if="job.state === 'uncertain'"> Request verification again if needed.</span></li></ul></li></ul></div>
      <div v-if="selected" class="forms-block"><h4>Responses: {{ selected.name }}</h4><p>Showing {{ submissions.length }} responses.</p><UButton :disabled="busy || !submissions.length" color="neutral" variant="outline" @click="exportCsv">Export all CSV</UButton><p v-if="!submissions.length">No responses to display.</p><UButton v-if="moreResponses" color="neutral" variant="outline" @click="inbox(selected, true)">Load more</UButton><ul><li v-for="row in submissions" :key="row.id"><p><time>{{ row.received_at }}</time> — {{ row.status }}</p><dl><template v-for="(value,key) in row.values" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl><ul><li v-for="job in deliveries.filter(item => item.response_id === row.id)" :key="job.id">Notification {{ recipients.find(item => item.id === job.recipient_id)?.email }}: {{ job.state }} <UButton v-if="job.state === 'failed' || job.state === 'uncertain'" color="neutral" variant="ghost" @click="retryDelivery(job)">Retry</UButton><span v-if="job.state === 'uncertain'"> Provider outcome unknown; check before resending.</span></li></ul><UButton color="neutral" variant="ghost" :disabled="busy" @click="status(row,'reviewed')">Mark reviewed</UButton><UButton color="neutral" variant="ghost" :disabled="busy" @click="status(row,'spam')">Mark spam</UButton><UButton color="neutral" variant="ghost" :disabled="busy" @click="deleting = row.id">Delete</UButton><div v-if="deleting === row.id"><p>Permanently delete this response and its notification history?</p><UButton color="error" :loading="busy" @click="deleteResponse(row)">Delete response</UButton><UButton color="neutral" variant="outline" @click="deleting = null">Cancel</UButton></div></li></ul></div>
    </div>
  </section>
</template>

<style scoped>
.forms-section { border-top: 1px solid #d9e1e7; padding: 12px 0; }
.forms-content { padding: 8px 12px 16px; }
.forms-content h3 { font-weight: 700; font-size: 14px; }
.forms-block { border-top: 1px solid #d9e1e7; padding: 16px 0; margin-top: 16px; }
.forms-block h4 { font-weight: 700; margin-bottom: 8px; }
.forms-block form, .forms-block fieldset, .forms-field { display: grid; gap: 8px; }
.forms-block fieldset { border: 1px solid #d9e1e7; padding: 12px; }
.forms-block label { display: block; }
.forms-block input:not([type=checkbox]), .forms-block select { border: 1px solid #53677e; border-radius: 4px; padding: 6px 8px; max-width: 100%; }
.forms-block code, .forms-block dd { overflow-wrap: anywhere; white-space: pre-wrap; }
.forms-block dt { font-weight: 600; }
.forms-block li { margin: 12px 0; }
</style>
