<script setup lang="ts">
import FormsNotifications from './FormsNotifications.vue'
import FormsSubmissionsTable from './FormsSubmissionsTable.vue'
import { csvCell } from "../utils/forms-csv"
import { formatInstant } from '#shared/utils/local-time'
import { submissionColumns } from '#shared/utils/forms-submissions-table'
import { FORMS_INBOX_PAGE_SIZE, formsInboxPath, formsInboxUrl, staticFormsInboxReads, type FormsInboxPage } from '#shared/utils/forms-inbox-client'
import { beginBody, confirmBody, isSavedResult, isVerifiedResult, ownerMessage, ownerPath, ownerUrl, pageQuery, parseChallenge, saveBody, sessionEndedError, isUnknownOutcome, type OwnerChallenge, type OwnerPage, type OwnerStep } from '#shared/utils/forms-owner-client'
import { responseUrl, responseBody, responseResult, responseUnknown, responseMessage, staticResponseEnabled } from '#shared/utils/forms-response-client'
type Field = { key: string; label: string; kind: 'text'|'email'|'telephone'|'multiline'; required: boolean; max_length: number }
type Host = { id: string; hostname: string; verified_at: string | null }
type Form = { id: string; form_key: string; name: string; fields: Field[]; active: boolean }
type Recipient = { id:string; email:string; verified_at:string|null; enabled:boolean }
type Delivery = { id:string; recipient_id:string; response_id:string|null; kind:string; state:string; attempts:number }
type Submission = { id: string; received_at: string; status: string; values: Record<string,string> }
const props = defineProps<{ websiteId: string; fqdn: string; mode?: 'legacy' | 'pilot' }>()
const { $supabase } = useNuxtApp()
const auth = useAuth()
const config = useRuntimeConfig()
// Optional local typing: the build lane owns the declaration and default of these settings.
const runtime = config.public as { apiBaseUrl?: unknown; staticDashboard?: boolean; rolloutFormsPilot?: boolean; rolloutFormsResponses?: boolean; rolloutFormsNotifications?: boolean }
const legacy = computed(() => props.mode === 'legacy')
const eligible = ref(false)
const eligibilityResolved = ref(false)
const notificationsAvailable = ref(false)
// Static pilot reads go through the authenticated API. Nitro/SSR builds keep direct Supabase reads.
const apiReads = computed(() => !legacy.value && eligible.value && staticFormsInboxReads(runtime.staticDashboard, runtime.rolloutFormsPilot))
const apiResponses = computed(() => !legacy.value && eligible.value && staticResponseEnabled(runtime.staticDashboard, runtime.rolloutFormsPilot, runtime.rolloutFormsResponses))
const responseControls = computed(() => legacy.value && runtime.staticDashboard !== true || apiResponses.value)
const responseUnresolved = ref(false)
// Static builds have no Nitro server, so eligibility is the API's boolean pilot-eligibility read (fails closed).
async function staticEligible(websiteId: string, token: string) {
  const result = await $fetch<{ eligible?: unknown; notifications_available?: unknown }>(ownerUrl(ownerPath.eligibility(websiteId), runtime.apiBaseUrl), { headers: { Authorization: `Bearer ${token}` }, retry: 0 })
  return result
}
let eligibilityGeneration = 0
let inboxGeneration = 0
watch(() => [auth.user.value?.id, auth.user.value?.is_anonymous, props.websiteId, props.mode] as const, async ([owner, anonymous, websiteId, mode]) => {
  const generation = ++eligibilityGeneration
  eligible.value = false
  eligibilityResolved.value = false
  notificationsAvailable.value = false
  if (mode !== 'pilot' || !owner || anonymous === true) return
  try {
    const token = await auth.accessToken()
    if (!token) return
    const staticPilot = staticFormsInboxReads(runtime.staticDashboard, runtime.rolloutFormsPilot)
    const result = staticPilot
      ? await staticEligible(websiteId, token)
      : await $fetch<{ eligible: boolean; notifications_available?: unknown }>('/api/forms/pilot-eligibility', { query: { website_id: websiteId }, headers: { Authorization: `Bearer ${token}` }, retry: 0 })
    if (generation === eligibilityGeneration && auth.user.value?.id === owner && auth.user.value?.is_anonymous !== true && props.websiteId === websiteId && props.mode === 'pilot') {
      eligible.value = result.eligible === true
      eligibilityResolved.value = true
      notificationsAvailable.value = staticPilot && eligible.value && result.notifications_available === true
    }
  } catch {
    if (generation === eligibilityGeneration && auth.user.value?.id === owner && auth.user.value?.is_anonymous !== true && props.websiteId === websiteId && props.mode === 'pilot') eligibilityResolved.value = true
  }
}, { immediate: true, flush: 'sync' })
const tab = ref<'responses' | 'setup'>('responses')
const busy = ref(false), error = ref(''), notice = ref('')
const hosts = ref<Host[]>([]), forms = ref<Form[]>([]), submissions = ref<Submission[]>([])
const deleting = ref<string|null>(null)
const recipients = ref<Recipient[]>([]), deliveries = ref<Delivery[]>([]), recipientEmail = ref('')
const selected = ref<Form | null>(null), editing = ref<string | null>(null), moreResponses = ref(false)
const hostname = ref(props.fqdn), challenge = ref<OwnerChallenge|null>(null)
// Set after an ambiguous DNS confirm or form save. Verify (or save) stays off until the owner reloads and checks the state.
const verifyUnknown = ref(false), saveUnknown = ref(false)
const name = ref(''), formKey = ref(''), enabled = ref(false), chosenHosts = ref<string[]>([])
const fields = ref<Field[]>([{key:'name',label:'Name',kind:'text',required:true,max_length:100},{key:'email',label:'Email',kind:'email',required:true,max_length:254}])
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : 'The request failed. Please try again.' }
function reset() { editing.value=null; name.value=''; formKey.value=''; enabled.value=false; chosenHosts.value=[]; saveUnknown.value=false; fields.value=[{key:'name',label:'Name',kind:'text',required:true,max_length:100},{key:'email',label:'Email',kind:'email',required:true,max_length:254}] }
// One authenticated page of the owner inbox API (static pilot reads only).
async function inboxPage<T>(path: string, offset: number): Promise<FormsInboxPage<T>> {
  const token = await auth.accessToken()
  if (!token) throw sessionEndedError()
  return $fetch<FormsInboxPage<T>>(formsInboxUrl(path, { limit: FORMS_INBOX_PAGE_SIZE, offset }, runtime.apiBaseUrl), { headers: { Authorization: `Bearer ${token}` }, retry: 0 })
}
// Static pilot owner calls (hosts, origins, verification, save). Only the closed owner routes are reachable here.
async function ownerBearer(): Promise<string> {
  const token = await auth.accessToken()
  if (!token) throw sessionEndedError()
  return token
}
async function ownerPage<T>(path: string, offset: number, extra: Record<string, string> = {}): Promise<OwnerPage<T>> {
  const token = await ownerBearer()
  const query = extra.form_id ? { form_id: extra.form_id, ...pageQuery(offset) } : pageQuery(offset)
  return $fetch<OwnerPage<T>>(ownerUrl(path, runtime.apiBaseUrl, query), { headers: { Authorization: `Bearer ${token}` }, retry: 0 })
}
async function ownerAll<T>(path: string, extra: Record<string, string> = {}): Promise<T[]> {
  const all: T[] = []
  for (let offset = 0; ;) {
    const page = await ownerPage<T>(path, offset, extra)
    if (!Array.isArray(page?.items)) throw new Error(ownerMessage('list', null))
    all.push(...page.items)
    if (!page.has_more || !page.items.length) return all
    offset += page.items.length
  }
}
// One owner write. The URL and body are built before the call. A success body that does not match the request is unknown, not a success.
async function ownerWrite(step: OwnerStep, path: string, body: Record<string, unknown>, accept: (value: unknown) => boolean): Promise<unknown> {
  const token = await ownerBearer()
  const url = ownerUrl(path, runtime.apiBaseUrl)
  let value: unknown
  try {
    value = await $fetch<unknown>(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body, retry: 0 })
  } catch (cause) {
    if (isUnknownOutcome(step, cause)) await reconcile(step)
    throw cause
  }
  if (!accept(value)) { await reconcile(step); throw new Error('The response did not match the request.') }
  return value
}
function failOwner(step: OwnerStep, cause: unknown) { error.value = ownerMessage(step, cause) }
// After an ambiguous outcome, reload the owner state before the user can act on it again.
async function reconcile(step: OwnerStep) {
  if (step === 'save-create' || step === 'save-update') saveUnknown.value = true
  if (step === 'confirm') verifyUnknown.value = true
  try { await load() } catch { /* The unknown-outcome message below still applies. */ }
}
async function apiForms(): Promise<{ data: Form[] | null; error: unknown }> {
  try {
    const all: Form[] = []
    for (let offset = 0; ; ) {
      const page = await inboxPage<Form>(formsInboxPath(props.websiteId), offset)
      all.push(...page.items)
      if (!page.has_more || !page.items.length) break
      offset += page.items.length
    }
    return { data: all, error: null }
  } catch (cause) { return { data: null, error: cause } }
}
// Static pilot hosts and origins come from the owner API. Every other path keeps the existing Supabase reads.
async function apiHosts(): Promise<{ data: Host[] | null; error: unknown }> {
  try { return { data: await ownerAll<Host>(ownerPath.hosts(props.websiteId)), error: null } } catch (cause) { return { data: null, error: cause } }
}
async function load() {
  const owner = auth.user.value?.id
  error.value=''
  const api = apiReads.value
  const [hostResult, formResult] = await Promise.all([
    api ? apiHosts() : $supabase.from('website_form_hosts').select('id,hostname,verified_at').eq('website_id',props.websiteId).order('hostname'),
    api ? apiForms() : $supabase.from('website_forms').select('id,form_key,name,fields,active').eq('website_id',props.websiteId).order('name'),
  ])
  if (!owner || auth.user.value?.id !== owner) return
  if (hostResult.error || formResult.error) { error.value='Could not load forms. Please try again.'; return }
  hosts.value=(hostResult.data ?? []) as Host[]; forms.value=(formResult.data ?? []) as Form[]
  if (!selected.value && forms.value.length) void inbox(forms.value[0]!)
  else if (selected.value && !forms.value.some(form => form.id === selected.value?.id)) {
    selected.value=null; submissions.value=[]; moreResponses.value=false
    if (forms.value.length) void inbox(forms.value[0]!)
  }
}
const submissionTableColumns = computed(() => submissionColumns(selected.value?.fields ?? [], submissions.value))
function selectForm(form: Form) {
  tab.value = 'responses'
  // Main cleared the unknown-outcome lock when the user reopened Responses for
  // a form; the reload that follows makes the fresh state authoritative.
  responseUnresolved.value = false
  void inbox(form)
}
async function begin() {
  busy.value=true; error.value=''; notice.value=''
  try {
    if (apiReads.value) {
      const value = await ownerWrite('begin', ownerPath.begin(props.websiteId), beginBody(hostname.value), value => parseChallenge(value) !== null)
      challenge.value = parseChallenge(value)
      verifyUnknown.value = false
    } else {
      const {data,error:err}=await $supabase.rpc('begin_form_host_verification',{p_website_id:props.websiteId,p_hostname:hostname.value.trim().toLowerCase()})
      if (err?.message === 'form_host_rate_limited') throw new Error('Too many verification requests. Try again in 10 minutes.')
      if (err?.message === 'form_host_limit') throw new Error('This website has reached its limit of 64 hosts.')
      if (err?.message === 'form_host_account_limit') throw new Error('This account has reached its limit of 256 hosts.')
      if (err) throw err
      challenge.value=data
    }
    await load()
  } catch(cause) { if (apiReads.value) failOwner('begin', cause); else fail(cause) } finally { busy.value=false }
}
async function verify() {
  if (!challenge.value) return
  const current = challenge.value
  busy.value=true; error.value=''; notice.value=''
  try {
    if (apiReads.value) {
      await ownerWrite('confirm', ownerPath.confirm(current.host_id), confirmBody(current.txt_value), value => isVerifiedResult(value, current.host_id))
      challenge.value=null; verifyUnknown.value=false; notice.value='Host verified.'; await load()
      return
    }
    const token=current.txt_value.slice('htp-verification='.length)
    const {data,error:err}=await $supabase.functions.invoke('form-verify',{body:{host_id:current.host_id,token}})
    if (err || !data?.ok) throw new Error('Could not verify the DNS record yet. Check the value and try again.')
    challenge.value=null; notice.value='Host verified.'; await load()
  } catch(cause) {
    if (!apiReads.value) { fail(cause); return }
    // An unknown confirm is reconciled by the host list. If the host now shows as verified, the challenge is closed.
    if (isUnknownOutcome('confirm', cause) && hosts.value.some(host => host.id === current.host_id && host.verified_at)) {
      challenge.value=null; verifyUnknown.value=false; notice.value='Host verified.'; return
    }
    failOwner('confirm', cause)
  } finally { busy.value=false }
}
async function edit(form:Form) {
  editing.value=form.id; name.value=form.name; formKey.value=form.form_key; enabled.value=form.active; fields.value=form.fields.map(field=>({...field})); saveUnknown.value=false
  if (apiReads.value) {
    try {
      const origins = await ownerAll<{ form_id: string; host_id: string }>(ownerPath.origins(props.websiteId), { form_id: form.id })
      if (editing.value === form.id) chosenHosts.value = origins.map(row => row.host_id)
    } catch (cause) { if (editing.value === form.id) error.value = ownerMessage('list', cause) }
    return
  }
  const {data,error:err}=await $supabase.from('website_form_origins').select('host_id').eq('website_id',props.websiteId).eq('form_id',form.id)
  if (err) { fail(err); return }; chosenHosts.value=(data ?? []).map((row: {host_id:string})=>row.host_id)
}
async function save() {
  busy.value=true; error.value=''; notice.value=''
  try {
    if (apiReads.value) {
      const formId = editing.value
      const body = saveBody({ formId, formKey: formKey.value, name: name.value, fields: fields.value, active: enabled.value, hostIds: chosenHosts.value })
      await ownerWrite(formId === null ? 'save-create' : 'save-update', ownerPath.forms(props.websiteId), body, value => isSavedResult(value, formKey.value))
      reset(); await load(); notice.value='Form saved.'
      return
    }
    const {error:err}=await $supabase.rpc('save_website_form',{p_website_id:props.websiteId,p_form_id:editing.value,p_form_key:formKey.value,p_name:name.value,p_fields:fields.value,p_active:enabled.value,p_host_ids:chosenHosts.value})
    if (err) throw err
    reset(); await load(); notice.value='Form saved.'
  } catch(cause) {
    if (apiReads.value) failOwner(editing.value === null ? 'save-create' : 'save-update', cause); else fail(cause)
  } finally { busy.value=false }
}
async function inbox(form:Form, more = false) {
  const generation = eligibilityGeneration, site = props.websiteId
  // Every selection, reload (including write reconciliation), or page supersedes older reads.
  const request = ++inboxGeneration
  const owner = auth.user.value?.id
  const current = () => request === inboxGeneration && generation === eligibilityGeneration && props.websiteId === site && !!owner && auth.user.value?.id === owner && auth.user.value?.is_anonymous !== true && selected.value?.id === form.id
  if (!more) { selected.value=form; submissions.value=[]; moreResponses.value=false; deleting.value=null }; error.value=''
  const offset = submissions.value.length
  let data: unknown, err: unknown, hasMore = false
  if (apiReads.value) {
    try { const page = await inboxPage<Submission>(formsInboxPath(props.websiteId, form.id), offset); data = page.items; hasMore = page.has_more } catch (cause) { err = cause }
  } else {
    const result = await $supabase.from('website_form_responses').select('id,received_at,status,values').eq('website_id',props.websiteId).eq('form_id',form.id).order('received_at',{ascending:false}).order('id').range(offset,offset + 99)
    data = result.data; err = result.error; hasMore = (result.data ?? []).length === 100
  }
  if (!current()) return
  if(err) { fail(err); return }; const rows=(data ?? []) as Submission[]; submissions.value.push(...rows); moreResponses.value=hasMore
  if (runtime.staticDashboard === true || !legacy.value) { recipients.value=[]; deliveries.value=[]; return }
  const result=await $supabase.from('website_form_recipients').select('id,email,verified_at,enabled').eq('website_id',props.websiteId).eq('form_id',form.id)
  if (!current()) return
  if (result.error) { fail(result.error); return }
  recipients.value=(result.data ?? []) as Recipient[]
  if (recipients.value.length) {
    const all:Delivery[]=[]
    for (let offset=0; ; offset+=500) {
      const jobs=await $supabase.from('website_form_delivery_jobs').select('id,recipient_id,response_id,kind,state,attempts').in('recipient_id',recipients.value.map(r=>r.id)).order('created_at',{ascending:false}).order('id').range(offset,offset+499)
      if (!current()) return
      if (jobs.error) { fail(jobs.error); return }
      all.push(...((jobs.data ?? []) as Delivery[]))
      if (!jobs.data || jobs.data.length<500) break
    }
    deliveries.value=all
  } else deliveries.value=[]
}
async function addRecipient() {
  if (runtime.staticDashboard === true || !legacy.value || !selected.value) return
  busy.value=true; error.value=''; notice.value=''
  try { const {error:err}=await $supabase.rpc('request_form_recipient',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_email:recipientEmail.value}); if (err) throw err; recipientEmail.value=''; notice.value='Verification email queued.'; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function disableRecipient(recipient:Recipient) {
  if (runtime.staticDashboard === true || !legacy.value || !selected.value) return
  busy.value=true; error.value=''
  try { const {error:err}=await $supabase.rpc('disable_form_recipient',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_recipient_id:recipient.id}); if(err) throw err; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function retryDelivery(job:Delivery) {
  if (runtime.staticDashboard === true || !legacy.value || !selected.value) return
  if (job.state === 'uncertain' && !window.confirm('The provider may already have delivered this notification. Resend and risk a duplicate email?')) return
  busy.value=true; error.value=''
  try { const {data,error:err}=await $supabase.rpc('retry_form_delivery',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_job_id:job.id}); if (err || !data) throw new Error('This delivery cannot be retried.'); await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
// Snapshot all affinity before obtaining a bearer; never fall back to RPC in static mode.
// `reload` is false for bulk rows so one action does not reset the loaded page
// after every write.
async function manageResponse(row: Submission, next?: string, reload = true) {
  const form = selected.value, owner = auth.user.value?.id, site = props.websiteId, generation = eligibilityGeneration
  if (!apiResponses.value || busy.value || responseUnresolved.value || !form || !owner || auth.user.value?.is_anonymous === true || !submissions.value.some(item => item.id === row.id) || (next === undefined && deleting.value !== row.id)) return
  const current = () => generation === eligibilityGeneration && apiResponses.value && props.websiteId === site && auth.user.value?.id === owner && auth.user.value?.is_anonymous !== true && selected.value?.id === form.id
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const url = responseUrl(site, form.id, row.id, next !== undefined, runtime.apiBaseUrl)
    const body = next === undefined ? undefined : responseBody(next)
    const token = await ownerBearer()
    if (!current()) return
    let value: unknown
    try {
      value = await $fetch<unknown>(url, { method: next === undefined ? 'DELETE' : 'PATCH', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body } : {}), retry: 0, redirect: 'error' })
      if (!responseResult(value, row.id, next)) throw new Error('Mismatched response result.')
    } catch (cause) {
      if (!current()) return
      if (responseUnknown(cause)) {
        responseUnresolved.value = true; deleting.value = null
        await inbox(form)
      }
      if (current()) error.value = responseMessage(cause, next === undefined)
      return
    }
    if (!current()) return false
    deleting.value = null
    if (reload) await inbox(form)
    return true
  } catch (cause) { if (current()) error.value = responseMessage(cause, next === undefined) }
  finally { busy.value = false }
  return false
}
// Bulk status is status only and acts on every selected loaded row, including
// rows across API pages. It stops on the first refusal or unknown outcome and
// reports succeeded, failed, unknown and not-attempted counts.
async function bulkStatus(ids: string[], next: string) {
  if (busy.value || responseUnresolved.value || !selected.value) return
  const rows = ids.map(id => submissions.value.find(row => row.id === id)).filter((row): row is Submission => !!row)
  if (!rows.length) return
  if (!apiResponses.value && !(legacy.value && responseControls.value)) return
  let changed = 0, failed = 0, unknown = false
  for (const row of rows) {
    if (responseUnresolved.value) { unknown = true; break }
    error.value = ''; notice.value = ''
    if (apiResponses.value) {
      if (await manageResponse(row, next, false)) { changed++; continue }
      if (responseUnresolved.value) { unknown = true; break }
      failed++; break
    }
    await status(row, next)
    if (error.value) { failed++; break }
    changed++
  }
  const notAttempted = rows.length - changed - failed - (unknown ? 1 : 0)
  // One reload after a successful or refused bulk pass keeps the table on the
  // bounded first page without dropping selected rows mid-loop.
  if (apiResponses.value && changed && !unknown) await inbox(selected.value)
  if (!failed && !unknown) notice.value = `${changed} response${changed === 1 ? '' : 's'} marked ${next}.`
  else notice.value = `Bulk status: ${changed} succeeded, ${failed} failed, ${unknown ? 1 : 0} unknown, ${notAttempted} not attempted.`
}
async function deleteResponse(row:Submission) {
  if (runtime.staticDashboard === true) { deleting.value = row.id; await manageResponse(row); return }
  if ( !legacy.value || !selected.value) return
  busy.value=true; error.value=''
  try { const {error:err}=await $supabase.rpc('delete_website_form_response',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_response_id:row.id}); if(err) throw err; deleting.value=null; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function status(row:Submission, next:string) {
  if (runtime.staticDashboard === true) { await manageResponse(row, next); return }
  if ( !legacy.value || !selected.value) return
  busy.value=true; error.value=''
  try { const {error:err}=await $supabase.rpc('set_website_form_response_status',{p_website_id:props.websiteId,p_form_id:selected.value.id,p_response_id:row.id,p_status:next}); if(err) throw err; await inbox(selected.value) } catch(cause) { fail(cause) } finally { busy.value=false }
}
async function exportCsv() {
  const form=selected.value, owner=auth.user.value?.id
  if (!form || !owner) return
  busy.value=true; error.value=''
  try {
    const rows: Submission[]=[]
    if (apiReads.value) {
      for (let offset=0; ; ) {
        const page = await inboxPage<Submission>(formsInboxPath(props.websiteId, form.id), offset)
        if (auth.user.value?.id !== owner) return
        rows.push(...page.items)
        if (!page.has_more || !page.items.length) break
        offset += page.items.length
      }
    } else for (let offset=0; ; offset+=500) {
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
watch(()=>[auth.user.value?.id, auth.user.value?.is_anonymous, props.websiteId, props.mode],()=>{ responseUnresolved.value=false; hosts.value=[]; forms.value=[]; submissions.value=[]; recipients.value=[]; deliveries.value=[]; selected.value=null; deleting.value=null; challenge.value=null; verifyUnknown.value=false; moreResponses.value=false; error.value=''; notice.value=''; tab.value='responses'; reset() })
// Load only after the pilot eligibility read resolves (or immediately in legacy
// mode), and reload on every site or owner change. The reset watch above clears
// per-site state first.
watch(() => [auth.user.value?.id, auth.user.value?.is_anonymous, props.websiteId, props.mode, legacy.value, eligible.value] as const, ([owner, anonymous, websiteId, mode, isLegacy, isEligible]) => {
  if (!owner || anonymous === true || !websiteId) return
  if (mode === 'pilot' && !isLegacy && !isEligible) return
  void load()
}, { immediate: true, flush: 'sync' })
</script>

<template>
  <section v-if="!legacy && eligibilityResolved && !eligible" class="forms-section forms-unavailable" :aria-label="`Forms for ${fqdn}`">
    <h2>Forms</h2>
    <p>Forms aren't enabled for {{ fqdn }}. The Forms pilot is limited to approved websites.</p>
  </section>
  <section v-else-if="legacy || eligible" class="forms-section" :aria-label="`Forms for ${fqdn}`">
    <div class="forms-content">
      <p v-if="error" class="form-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <div v-if="forms.length" class="form-selector" role="group" aria-label="Choose a form">
        <button v-for="form in forms" :key="form.id" type="button" class="form-choice" :class="{ selected: selected?.id === form.id }" :aria-pressed="selected?.id === form.id" @click="selectForm(form)">
          <strong>{{ form.name }}</strong><span class="form-state">{{ form.active ? 'Active' : 'Paused' }}</span>
        </button>
      </div>
      <div class="forms-tabs" role="tablist" aria-label="Forms sections">
        <button type="button" role="tab" :aria-selected="tab === 'responses'" :class="{ active: tab === 'responses' }" @click="tab = 'responses'">Responses</button>
        <button type="button" role="tab" :aria-selected="tab === 'setup'" :class="{ active: tab === 'setup' }" @click="tab = 'setup'">Setup</button>
      </div>

      <div v-if="tab === 'responses'" role="tabpanel" aria-label="Responses">
        <div v-if="selected" class="forms-block">
          <h3>Responses: {{ selected.name }}</h3>
          <FormsSubmissionsTable
            :rows="submissions"
            :columns="submissionTableColumns"
            :has-more="moreResponses"
            :loading="busy"
            :busy="busy"
            :locked="responseUnresolved"
            :can-manage="responseControls"
            :can-mark-new="apiResponses"
            @status="status"
            @delete="deleteResponse"
            @bulk-status="bulkStatus"
            @load-more="inbox(selected, true)"
            @export="exportCsv"
          >
            <template #row-extra="{ row }">
              <ul v-if="legacy" class="legacy-deliveries">
                <li v-for="job in deliveries.filter(item => item.response_id === row.id)" :key="job.id">Notification {{ recipients.find(item => item.id === job.recipient_id)?.email }}: {{ job.state }} <UButton v-if="job.state === 'failed' || job.state === 'uncertain'" color="neutral" variant="ghost" @click="retryDelivery(job)">Retry</UButton><span v-if="job.state === 'uncertain'"> Provider outcome unknown; check before resending.</span></li>
              </ul>
            </template>
          </FormsSubmissionsTable>
        </div>
        <p v-else class="forms-empty">No form selected. Create a form in Setup, then its responses appear here.</p>
      </div>

      <div v-else role="tabpanel" aria-label="Setup">
        <div class="forms-block">
          <h3>Verify a website host</h3>
          <p>Verify each exact host before collecting inquiries. A form can use one or more verified hosts.</p>
          <form @submit.prevent="begin"><label>Hostname <input v-model="hostname" required maxlength="253" placeholder="www.example.com"></label> <UButton type="submit" :loading="busy" :disabled="verifyUnknown">Create DNS challenge</UButton></form>
          <div v-if="challenge"><p>Add this TXT record to your DNS, then verify it. The challenge expires after 24 hours.</p><p>Name: <code>{{ challenge.txt_name }}</code></p><p>Value: <code>{{ challenge.txt_value }}</code></p><UButton :loading="busy" :disabled="verifyUnknown" @click="verify">Verify DNS record</UButton></div>
          <ul><li v-for="host in hosts" :key="host.id">{{ host.hostname }} — <template v-if="host.verified_at">Verified <time :datetime="host.verified_at" :title="host.verified_at">{{ formatInstant(host.verified_at) }}</time></template><template v-else>Not verified</template></li></ul>
        </div>
        <div class="forms-block">
          <h3>{{ editing ? 'Edit form' : 'Create a form' }}</h3>
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
            <div><UButton type="submit" :loading="busy" :disabled="saveUnknown">Save form</UButton> <UButton v-if="editing" type="button" color="neutral" variant="outline" @click="reset">Cancel edit</UButton></div>
          </form>
        </div>
        <div class="forms-block"><h3>Your forms</h3><p v-if="!forms.length">No forms yet.</p><ul><li v-for="form in forms" :key="form.id"><strong>{{ form.name }}</strong> — {{ form.active ? 'Active' : 'Paused' }} <UButton color="neutral" variant="ghost" @click="edit(form)">Edit</UButton><UButton color="neutral" variant="ghost" @click="selectForm(form)">Responses</UButton><p>Submission endpoint: <code>{{ config.public.apiBaseUrl }}/public/forms/{{ form.id }}</code></p></li></ul></div>
        <FormsNotifications v-if="selected && notificationsAvailable && apiReads && runtime.staticDashboard === true && runtime.rolloutFormsNotifications === true" :key="`${websiteId}:${selected.id}:${auth.user.value?.id}`" :website-id="websiteId" :form-id="selected.id" />
        <div v-if="selected && legacy && runtime.staticDashboard !== true" class="forms-block"><h3>Notification recipients</h3><p>Each recipient must confirm their address before inquiries are sent. Delivery status records whether the email provider accepted the message.</p><form @submit.prevent="addRecipient"><label>Email address <input v-model="recipientEmail" type="email" required maxlength="254"></label><UButton type="submit" :loading="busy">Send verification</UButton></form><ul><li v-for="recipient in recipients" :key="recipient.id">{{ recipient.email }} — {{ !recipient.enabled ? 'Disabled' : recipient.verified_at ? 'Verified' : 'Awaiting verification' }} <UButton v-if="recipient.enabled" color="neutral" variant="ghost" @click="disableRecipient(recipient)">Disable</UButton><ul><li v-for="job in deliveries.filter(item => item.recipient_id === recipient.id && item.kind === 'verification')" :key="job.id">Verification: {{ job.state }} <UButton v-if="job.state === 'failed'" color="neutral" variant="ghost" @click="retryDelivery(job)">Retry</UButton><span v-if="job.state === 'uncertain'"> Request verification again if needed.</span></li></ul></li></ul></div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.forms-section { border-top: 1px solid var(--border); padding: 12px 0; }
.forms-content { padding: 8px 0 16px; display: grid; gap: 16px; }
.forms-unavailable h2 { font-size: 24px; margin-bottom: 6px; }
.forms-unavailable p { color: var(--muted); max-width: 65ch; }
.forms-content h2, .forms-content h3 { font-weight: 650; letter-spacing: -.02em; }
.forms-content h2 { font-size: 24px; }
.forms-content h3 { font-size: 19px; margin-bottom: 8px; }
.forms-empty { color: var(--muted); font-size: 13px; }
.form-selector { display: flex; flex-wrap: wrap; gap: 8px; }
.form-choice { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; background: #fff; color: var(--ink); font-size: 13px; text-align: left; }
.form-choice.selected { border-color: var(--rust); box-shadow: inset 0 -2px 0 var(--rust); }
.form-choice strong { font-weight: 600; }
.form-state { color: var(--muted); font-size: 12px; }
.forms-tabs { display: flex; gap: 20px; border-bottom: 1px solid var(--border); }
.forms-tabs button { min-height: 44px; padding: 8px 0; color: var(--muted); font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.forms-tabs button.active { color: var(--ink); border-bottom-color: var(--rust); }
.forms-block { border-top: 1px solid var(--border); padding: 16px 0; }
.forms-block:first-child { border-top: 0; }
.forms-block form, .forms-block fieldset, .forms-field { display: grid; gap: 8px; }
/* Primary actions keep a compact width inside the grid forms, matching the
   sibling controls instead of stretching across the panel. */
.forms-block form > button { justify-self: start; }
.forms-block fieldset { border: 1px solid var(--border); padding: 12px; }
.forms-block label { display: block; }
.forms-block input:not([type=checkbox]), .forms-block select { border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; max-width: 100%; font-size: 14px; }
.forms-block code, .forms-block dd { overflow-wrap: anywhere; white-space: pre-wrap; }
.forms-block dt { font-weight: 600; }
.forms-block li { margin: 12px 0; }
.forms-block p { color: var(--muted); max-width: 70ch; }
.legacy-deliveries { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 6px; }
@media (max-width: 650px) {
  .form-choice { width: 100%; }
  .forms-tabs { gap: 14px; }
  .forms-tabs button { flex: 1; min-height: 44px; }
  .forms-block li { margin: 16px 0; }
}
</style>
