import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('pilot gate keeps held grants, enforces owner/site, and preserves retry data', async () => {
 const db=new PGlite(); const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', site2='00000000-0000-0000-0000-000000000004', form='00000000-0000-0000-0000-000000000005', host='00000000-0000-0000-0000-000000000006', submission='00000000-0000-0000-0000-000000000007'
 const held=['begin_form_host_verification(uuid,text)','form_host_challenge(uuid)','save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])','set_website_form_response_status(uuid,uuid,uuid,text)','request_form_recipient(uuid,uuid,text)','disable_form_recipient(uuid,uuid,uuid)','retry_form_delivery(uuid,uuid,uuid)','delete_website_form_response(uuid,uuid,uuid)']
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
  for(const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql','20261122000200_forms_host_verification.sql','20261122000300_forms_management.sql','20261122000400_forms_notifications.sql','20261122000500_forms_response_deletion.sql','20261122000600_forms_rename_safety.sql','20261122000700_forms_ingress_gate.sql','20261122000800_forms_uncertain_retry.sql','20261122000900_forms_client_admission.sql','20261128000000_forms_host_challenge_quota.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
  for(const name of held) await db.exec(`revoke execute on function public.${name} from public,anon,authenticated`)
  const prototype=await readFile(new URL('../migrations/20261201000000_forms_pilot_scope.sql',import.meta.url),'utf8')
  await db.exec("select set_config('forms.pilot_fixture','disposable',false)")
  await db.exec('alter function public.form_host_challenge(uuid) set search_path=public')
  await assert.rejects(()=>db.exec(prototype),/forms_pilot_function_drift/);await db.exec('rollback')
  assert.equal((await db.query("select to_regclass('public.forms_pilot_approved_sites') name")).rows[0].name,null)
  await db.exec("alter function public.form_host_challenge(uuid) set search_path=''")
  // Model provider default table grants and a dangerous inherited grant.
  await db.exec('create role pilot_inherited; grant pilot_inherited to service_role with inherit false, set true; alter default privileges in schema public grant all on tables to service_role; alter default privileges in schema public grant insert on tables to pilot_inherited')
  await assert.rejects(()=>db.exec(prototype),/pilot_approval_privilege_drift/); await db.exec('rollback')
  assert.equal((await db.query("select to_regclass('public.forms_pilot_approved_sites') name")).rows[0].name,null)
  await db.exec('alter default privileges in schema public revoke insert on tables from pilot_inherited; alter default privileges in schema public grant maintain on tables to pilot_inherited')
  await assert.rejects(()=>db.exec(prototype),/pilot_approval_privilege_drift/); await db.exec('rollback')
  assert.equal((await db.query("select to_regclass('public.forms_pilot_approved_sites') name")).rows[0].name,null)
  await db.exec('alter default privileges in schema public revoke maintain on tables from pilot_inherited')
  await db.exec(prototype)
  for(const role of ['anon','authenticated','service_role']) {
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) assert.equal((await db.query("select has_table_privilege($1,'public.forms_pilot_approved_sites',$2) allowed",[role,privilege])).rows[0].allowed,false)
    for(const column of ['website_id','owner_id']) for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']) assert.equal((await db.query("select has_column_privilege($1,'public.forms_pilot_approved_sites',$2,$3) allowed",[role,column,privilege])).rows[0].allowed,false)
    assert.equal((await db.query("select has_function_privilege($1,'public.forms_pilot_site_allowed(uuid)','execute') allowed",[role])).rows[0].allowed,false)
  }
  await db.exec('set role service_role')
  await assert.rejects(()=>db.query('insert into public.forms_pilot_approved_sites values($1,$2)',[site,owner]),/permission denied/)
  await db.exec('reset role')
  for(const name of held) for(const role of ['anon','authenticated']) assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,`public.${name}`,'execute'])).rows[0].allowed,false)
  await db.query('insert into auth.users values($1),($2)',[owner,other]); await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com'),($3,$2,'other.example.com')",[site,owner,site2])
  await db.query("insert into public.website_forms(id,website_id,form_key,name,fields,active) values($1,$2,'quote','Quote','[{\"key\":\"name\",\"label\":\"Name\",\"kind\":\"text\",\"required\":false,\"max_length\":100}]',true)",[form,site])
  await db.query("insert into public.website_form_hosts(id,website_id,hostname,challenge_hash,verified_at) values($1,$2,'example.com','hash',now())",[host,site]);await db.query('insert into public.website_form_origins values($1,$2,$3)',[site,form,host])
  const accept=()=>db.query("select public.accept_website_form($1,$2,'example.com','{}') result",[form,submission])
  assert.equal((await accept()).rows[0].result.error,'form_unavailable')
  await db.query('insert into public.forms_pilot_approved_sites values($1,$2)',[site,owner])
  await db.exec('set role service_role')
  await assert.rejects(()=>db.query('update public.forms_pilot_approved_sites set owner_id=$1 where website_id=$2',[other,site]),/permission denied/)
  await assert.rejects(()=>db.query('delete from public.forms_pilot_approved_sites where website_id=$1',[site]),/permission denied/)
  await assert.rejects(()=>db.query('select public.forms_pilot_site_allowed($1)',[site]),/permission denied/)
  await db.exec('reset role')
  assert.equal((await accept()).rows[0].result.duplicate,false);assert.equal((await accept()).rows[0].result.duplicate,true)
  for(const name of held) await db.exec(`grant execute on function public.${name} to authenticated`)
  const host2='00000000-0000-0000-0000-000000000009'
  await db.query("insert into public.website_form_hosts(id,website_id,hostname,challenge_hash) values($1,$2,'other.example.com','hash')",[host2,site2])
  const response=(await db.query('select id from public.website_form_responses where form_id=$1',[form])).rows[0].id
  const identity=async id=>{await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,is_anonymous:false})])}
  const matrix=(website,whichHost)=>[
    ["select public.begin_form_host_verification($1,'x.example.com')",[website]],
    ['select public.form_host_challenge($1)',[whichHost]],
    ["select public.save_website_form($1,null,'quote','Quote','[]',false,'{}')",[website]],
    ["select public.set_website_form_response_status($1,$2,$3,'reviewed')",[website,form,response]],
    ["select public.request_form_recipient($1,$2,'a@example.com')",[website,form]],
    ['select public.disable_form_recipient($1,$2,$3)',[website,form,host]],
    ['select public.retry_form_delivery($1,$2,$3)',[website,form,host]],
    ['select public.delete_website_form_response($1,$2,$3)',[website,form,response]],
  ]
  await identity(other);for(const [sql,args] of matrix(site,host)) await assert.rejects(()=>db.query(sql,args),/not found/i)
  await identity(owner);for(const [sql,args] of matrix(site2,host2)) await assert.rejects(()=>db.query(sql,args),/not found/i)
  await identity(other);await assert.rejects(()=>db.query("select public.begin_form_host_verification($1,'example.com')",[site]),/Website not found/)
  await assert.rejects(()=>db.query('select public.form_host_challenge($1)',[host]),/Host not found/)
  await identity(owner);await assert.rejects(()=>db.query("select public.begin_form_host_verification($1,'other.example.com')",[site2]),/Website not found/)
  assert.equal((await db.query('select public.form_host_challenge($1) value',[host])).rows[0].value.hostname,'example.com')
  assert.ok((await db.query("select public.begin_form_host_verification($1,'www.example.com') value",[site])).rows[0].value.host_id)
  assert.ok((await db.query("select public.save_website_form($1,null,'extra','Extra',$2,false,'{}') value",[site,JSON.stringify([{key:'name',label:'Name',kind:'text',required:false,max_length:100}])])).rows[0].value.id)
  await assert.rejects(()=>db.query("select public.request_form_recipient($1,$2,'a@example.com')",[site2,form]),/Form not found/)
  await assert.rejects(()=>db.query("select public.save_website_form($1,null,'quote','Quote','[]',false,'{}')",[site2]),/Website not found/)
  assert.equal((await db.query("select (public.set_website_form_response_status($1,$2,$3,'reviewed'))->>'status' status",[site,form,response])).rows[0].status,'reviewed')
  const recipient=(await db.query("select public.request_form_recipient($1,$2,'fixture@example.invalid') id",[site,form])).rows[0].id
  await db.exec('reset role')
  const job=(await db.query("update public.website_form_delivery_jobs set state='failed' where recipient_id=$1 returning id",[recipient])).rows[0].id
  await identity(owner)
  assert.equal((await db.query('select public.retry_form_delivery($1,$2,$3) ok',[site,form,job])).rows[0].ok,true)
  assert.equal((await db.query('select public.disable_form_recipient($1,$2,$3) ok',[site,form,recipient])).rows[0].ok,true)
  await db.exec('reset role')
  const extra='00000000-0000-0000-0000-000000000010'
  assert.equal((await db.query("select public.accept_website_form($1,$2,'example.com','{}') result",[form,extra])).rows[0].result.ok,true)
  const extraResponse=(await db.query('select id from public.website_form_responses where submission_id=$1',[extra])).rows[0].id
  await identity(owner)
  assert.equal((await db.query('select public.delete_website_form_response($1,$2,$3) ok',[site,form,extraResponse])).rows[0].ok,true)
  await db.exec('reset role');await db.query('update public.websites set owner_id=$1 where id=$2',[other,site]);assert.equal((await accept()).rows[0].result.error,'form_unavailable')
  await db.query('update public.websites set owner_id=$1 where id=$2',[owner,site]);await db.query('delete from public.forms_pilot_approved_sites where website_id=$1',[site]);assert.equal((await accept()).rows[0].result.error,'form_unavailable')
  assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,1)
  await db.query('insert into public.forms_pilot_approved_sites values($1,$2)',[site,owner])
  assert.equal((await accept()).rows[0].result.duplicate,true)
  const disable=await readFile(new URL('../rollbacks/20261201000000_forms_pilot_scope_disable.sql',import.meta.url),'utf8')
  await db.exec('grant execute on function public.accept_website_form(uuid,uuid,text,jsonb) to pilot_inherited')
  await assert.rejects(()=>db.exec(disable),/forms_pilot_service_hold_drift/);await db.exec('rollback')
  assert.equal((await db.query("select has_function_privilege('service_role','public.accept_website_form(uuid,uuid,text,jsonb)','execute') allowed")).rows[0].allowed,true)
  await db.exec('revoke execute on function public.accept_website_form(uuid,uuid,text,jsonb) from pilot_inherited')
  await db.exec(disable)
  assert.notEqual((await db.query("select to_regclass('public.forms_pilot_approved_sites') name")).rows[0].name,null)
  assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,1)
  for(const name of held) for(const role of ['anon','authenticated']) assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,`public.${name}`,'execute'])).rows[0].allowed,false)
  assert.notEqual((await db.query("select to_regclass('public.forms_pilot_approved_sites') name")).rows[0].name,null)
  assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,1)
  for(const name of ['accept_website_form(uuid,uuid,text,jsonb)','website_form_origin_allowed(uuid,text)','complete_form_host_verification(uuid,text)']) assert.equal((await db.query("select has_function_privilege('service_role',$1,'execute') allowed",[`public.${name}`])).rows[0].allowed,false)
 } finally {await db.close()}
})
