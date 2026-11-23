import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('forms isolate owner reads, prevent public writes and preserve responses on deletion', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql', '20261122000000_website_forms.sql', '20261122000100_forms_acceptance.sql']) {
      await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
    }
    const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002'
    const site = '00000000-0000-0000-0000-000000000003', form = '00000000-0000-0000-0000-000000000004'
    const submission = '00000000-0000-0000-0000-000000000005'
    await db.exec(`insert into auth.users values ('${owner}'), ('${other}');
      insert into public.websites(id,owner_id,fqdn) values ('${site}','${owner}','www.example.com');
      insert into public.website_forms(id,website_id,form_key,name,fields) values ('${form}','${site}','quote','Quote','[]');
      insert into public.website_form_responses(website_id,form_id,submission_id,values) values ('${site}','${form}','${submission}','{"name":"Ada"}');`)
    await assert.rejects(() => db.exec(`insert into public.website_form_responses(website_id,form_id,submission_id,values) values ('${site}','${form}','${submission}','{}')`), /unique/)
    await assert.rejects(() => db.exec(`delete from public.websites where id='${site}'`), /foreign key/)
    const identity = async (id, anonymous = false) => {
      await db.exec('reset role; set role authenticated')
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id, is_anonymous: anonymous })])
    }
    await identity(owner)
    assert.equal((await db.query('select * from public.website_form_responses')).rows.length, 1)
    await assert.rejects(() => db.exec("update public.website_form_responses set status='reviewed'"), /permission denied/)
    await identity(other)
    assert.equal((await db.query('select * from public.website_forms')).rows.length, 0)
    assert.equal((await db.query('select * from public.website_form_responses')).rows.length, 0)
    await identity(owner, true)
    assert.equal((await db.query('select * from public.website_form_responses')).rows.length, 0)
    await db.exec('reset role; set role anon')
    await assert.rejects(() => db.query('select * from public.website_form_responses'), /permission denied/)
  } finally { await db.close() }
})

test('acceptance checks verified host, validation and idempotency', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'))
    const owner='00000000-0000-0000-0000-000000000001', site='00000000-0000-0000-0000-000000000002', form='00000000-0000-0000-0000-000000000003', host='00000000-0000-0000-0000-000000000004', request='00000000-0000-0000-0000-000000000005'
    await db.query('insert into auth.users values ($1)',[owner])
    await db.query("insert into public.websites(id,owner_id,fqdn) values ($1,$2,'www.example.com')",[site,owner])
    const fields=[{key:'name',kind:'text',required:true,max_length:100},{key:'email',kind:'email',required:true,max_length:254}]
    await db.query("insert into public.website_forms(id,website_id,form_key,name,fields,active) values($1,$2,'quote','Quote',$3,true)",[form,site,JSON.stringify(fields)])
    await db.query("insert into public.website_form_hosts(id,website_id,hostname,challenge_hash) values($1,$2,'www.example.com','hash')",[host,site])
    await db.query('insert into public.website_form_origins values($1,$2,$3)',[site,form,host])
    const accept=async (values, hostname='www.example.com') => (await db.query('select public.accept_website_form($1,$2,$3,$4) as result',[form,request,hostname,JSON.stringify(values)])).rows[0].result
    assert.equal((await accept({name:'Ada',email:'ada@example.com'})).error,'form_unavailable')
    await db.query('update public.website_form_hosts set verified_at=now() where id=$1',[host])
    assert.equal((await accept({name:'Ada',email:'ada@example.com'},'example.com')).error,'form_unavailable')
    assert.equal((await accept({name:'Ada',email:'invalid'})).error,'validation_failed')
    assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,0)
    assert.equal((await accept({name:'Ada',email:'ada@example.com'})).ok,true)
    assert.equal((await accept({name:'Ada',email:'ada@example.com'})).duplicate,true)
    assert.equal((await accept({name:'Eve',email:'ada@example.com'})).error,'idempotency_conflict')
    assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,1)
    await db.query('update public.website_forms set active=false where id=$1',[form])
    assert.equal((await accept({name:'Ada',email:'ada@example.com'})).error,'form_unavailable')
    await db.query('update public.website_forms set active=true where id=$1',[form])
    await db.query('update public.website_form_rate_windows set count=100 where form_id=$1',[form])
    const limited=(await db.query('select public.accept_website_form($1,$2,$3,$4) result',[form,'00000000-0000-0000-0000-000000000006','www.example.com',JSON.stringify({name:'Ada',email:'ada@example.com'})])).rows[0].result
    assert.equal(limited.error,'rate_limited')
    await db.exec('set role anon')
    await assert.rejects(() => accept({name:'Ada',email:'ada@example.com'}),/permission denied/)
  } finally { await db.close() }
})

test('only the owner can issue a random host challenge and only service can complete it', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql','20261122000200_forms_host_verification.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url),'utf8'))
    const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003'
    await db.query('insert into auth.users values ($1),($2)',[owner,other])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'www.example.com')",[site,owner])
    async function identity(user) { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:false})]) }
    await identity(other)
    await assert.rejects(()=>db.query("select public.begin_form_host_verification($1,'www.example.com')",[site]),/Website not found/)
    await identity(owner)
    const first=(await db.query("select public.begin_form_host_verification($1,'www.example.com') result",[site])).rows[0].result
    const challenge=(await db.query('select public.form_host_challenge($1) result',[first.host_id])).rows[0].result
    await assert.rejects(()=>db.query('select public.complete_form_host_verification($1,$2)',[first.host_id,challenge.challenge_hash]),/permission denied/)
    const second=(await db.query("select public.begin_form_host_verification($1,'www.example.com') result",[site])).rows[0].result
    assert.notEqual(first.txt_value,second.txt_value)
    await db.exec('reset role; set role service_role')
    assert.equal((await db.query('select public.complete_form_host_verification($1,$2) result',[first.host_id,challenge.challenge_hash])).rows[0].result,false)
    await db.exec('reset role')
    assert.equal((await db.query('select verified_at from public.website_form_hosts where id=$1',[first.host_id])).rows[0].verified_at,null)
  } finally { await db.close() }
})

test('form configuration is owner scoped and activation requires verified associated hosts', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql','20261122000200_forms_host_verification.sql','20261122000300_forms_management.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url),'utf8'))
    const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', host='00000000-0000-0000-0000-000000000004'
    await db.query('insert into auth.users values ($1),($2)',[owner,other])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'www.example.com')",[site,owner])
    await db.query("insert into public.website_form_hosts(id,website_id,hostname,challenge_hash,verified_at) values($1,$2,'www.example.com','test',now())",[host,site])
    const fields=[{key:'name',label:'Name',kind:'text',required:true,max_length:100}]
    async function identity(user) { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:false})]) }
    const save=(id,active,hosts,defs=fields)=>db.query("select public.save_website_form($1,$2,'quote','Quote',$3,$4,$5) result",[site,id,JSON.stringify(defs),active,hosts])
    await identity(other)
    await assert.rejects(()=>save(null,true,[host]),/Website not found/)
    await identity(owner)
    await assert.rejects(()=>save(null,true,[]),/verified host/)
    await assert.rejects(()=>save(null,true,[host],[...fields,...fields]),/Invalid field definition/)
    const form=(await save(null,true,[host])).rows[0].result
    assert.equal(form.active,true)
    await identity(other)
    await assert.rejects(()=>save(form.id,false,[]),/Website not found/)
    await identity(owner)
    assert.equal((await save(form.id,false,[])).rows[0].result.active,false)
    await db.exec('reset role')
    const response='00000000-0000-0000-0000-000000000005'
    await db.query("insert into public.website_form_responses(id,website_id,form_id,submission_id,values) values($1,$2,$3,'00000000-0000-0000-0000-000000000006','{}')",[response,site,form.id])
    await identity(other)
    await assert.rejects(()=>db.query("select public.set_website_form_response_status($1,$2,$3,'reviewed')",[site,form.id,response]),/Response not found/)
    await identity(owner)
    assert.equal((await db.query("select public.set_website_form_response_status($1,$2,$3,'reviewed') result",[site,form.id,response])).rows[0].result.status,'reviewed')
    await assert.rejects(()=>db.query("select public.set_website_form_response_status($1,$2,$3,'ignored')",[site,form.id,response]),/Invalid status/)
  } finally { await db.close() }
})

test('verified recipients receive a single queued delivery and failed sends can be retried by the owner', async () => {
  const db=new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    for(const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql','20261122000200_forms_host_verification.sql','20261122000300_forms_management.sql','20261122000400_forms_notifications.sql','20261122000500_forms_response_deletion.sql','20261122000600_forms_rename_safety.sql','20261122000700_forms_ingress_gate.sql','20261122000800_forms_uncertain_retry.sql','20261122000900_forms_client_admission.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
    const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', form='00000000-0000-0000-0000-000000000004', response='00000000-0000-0000-0000-000000000005'
    await db.query('insert into auth.users values($1),($2)',[owner,other])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
    await db.query("insert into public.website_forms(id,website_id,form_key,name,fields) values($1,$2,'quote','Quote','[]')",[form,site])
    async function identity(user){await db.exec('reset role; set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:false})])}
    await identity(other)
    await assert.rejects(()=>db.query("select public.request_form_recipient($1,$2,'owner@example.com')",[site,form]),/Form not found/)
    await identity(owner)
    const recipient=(await db.query("select public.request_form_recipient($1,$2,'owner@example.com') id",[site,form])).rows[0].id
    await assert.rejects(()=>db.query('select public.confirm_form_recipient($1,$2)',[recipient,'a'.repeat(64)]),/permission denied/)
    await db.exec('reset role; set role service_role')
    const verify=(await db.query('select public.claim_form_delivery() job')).rows[0].job
    assert.equal(verify.kind,'verification')
    await db.exec('reset role')
    await assert.rejects(()=>db.query('delete from public.websites where id=$1',[site]),error=>error.code==='23503' && /currently sending/.test(error.message))
    await db.exec('set role service_role')
    assert.equal((await db.query('select public.confirm_form_recipient($1,$2) ok',[recipient,verify.token])).rows[0].ok,true)
    assert.equal((await db.query("select public.finish_form_delivery($1,$2,'sent') ok",[verify.id,verify.lease])).rows[0].ok,true)
    await db.exec('reset role')
    await db.query("insert into public.website_form_responses(id,website_id,form_id,submission_id,values) values($1,$2,$3,'00000000-0000-0000-0000-000000000006','{}')",[response,site,form])
    await db.exec('set role service_role')
    const delivery=(await db.query('select public.claim_form_delivery() job')).rows[0].job
    assert.equal(delivery.kind,'response')
    assert.equal((await db.query('select public.claim_form_delivery() job')).rows[0].job,null)
    assert.equal((await db.query("select public.finish_form_delivery($1,$2,'failed') ok",[delivery.id,delivery.lease])).rows[0].ok,true)
    await identity(other)
    await assert.rejects(()=>db.query('select public.retry_form_delivery($1,$2,$3)',[site,form,delivery.id]),/Delivery not found/)
    await identity(owner)
    assert.equal((await db.query('select public.retry_form_delivery($1,$2,$3) ok',[site,form,delivery.id])).rows[0].ok,true)
    await db.exec('reset role; set role service_role')
    const retry=(await db.query('select public.claim_form_delivery() job')).rows[0].job
    assert.equal(retry.id,delivery.id)
    assert.equal((await db.query("select public.finish_form_delivery($1,$2,'sent') ok",[delivery.id,delivery.lease])).rows[0].ok,false)
    await identity(owner)
    await assert.rejects(()=>db.query('select public.delete_website_form_response($1,$2,$3)',[site,form,response]),/currently sending/)
    // An expired lease is uncertain, never automatically resent or accepted
    // as a successful finish from the stale worker.
    await db.exec('reset role')
    await db.query("update public.website_form_delivery_jobs set leased_until=now()-interval '1 second' where id=$1",[retry.id])
    await db.exec('set role service_role')
    assert.equal((await db.query("select public.finish_form_delivery($1,$2,'sent') ok",[retry.id,retry.lease])).rows[0].ok,false)
    assert.equal((await db.query('select public.claim_form_delivery() job')).rows[0].job,null)
    await db.exec('reset role')
    assert.equal((await db.query('select state from public.website_form_delivery_jobs where id=$1',[retry.id])).rows[0].state,'uncertain')
    assert.equal((await db.query("select count(*)::int n from public.website_form_delivery_jobs where kind='response'")).rows[0].n,1)
    await identity(other)
    await assert.rejects(()=>db.query('select public.retry_form_delivery($1,$2,$3)',[site,form,delivery.id]),/Delivery not found/)
    await identity(owner)
    assert.equal((await db.query('select public.retry_form_delivery($1,$2,$3) ok',[site,form,delivery.id])).rows[0].ok,true)
    await db.exec('reset role; set role service_role')
    const resend=(await db.query('select public.claim_form_delivery() job')).rows[0].job
    assert.equal(resend.id,delivery.id)
    assert.equal((await db.query("select public.finish_form_delivery($1,$2,'sent') ok",[resend.id,resend.lease])).rows[0].ok,true)
    await identity(other)
    await assert.rejects(()=>db.query('select public.delete_website_form_response($1,$2,$3)',[site,form,response]),/Response not found/)
    await identity(owner)
    assert.equal((await db.query('select public.delete_website_form_response($1,$2,$3) ok',[site,form,response])).rows[0].ok,true)
    await db.exec('reset role')
    assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,0)
    assert.equal((await db.query('select count(*)::int n from public.website_form_submission_tombstones')).rows[0].n,1)
    await db.query("insert into public.website_form_hosts(id,website_id,hostname,challenge_hash,verified_at) values('00000000-0000-0000-0000-000000000007',$1,'example.com','hash',now())",[site])
    await db.query("insert into public.website_form_origins values($1,$2,'00000000-0000-0000-0000-000000000007')",[site,form])
    await db.query('update public.website_forms set active=true where id=$1',[form])
    const replay=(await db.query("select public.accept_website_form($1,'00000000-0000-0000-0000-000000000006','example.com','{}') result",[form])).rows[0].result
    assert.equal(replay.duplicate,true)
    assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,0)
    await db.query('update public.website_forms set fields=$1 where id=$2',[JSON.stringify([{key:'name',label:'Name',kind:'text',required:false,max_length:100}]),form])
    const newId='00000000-0000-0000-0000-000000000008'
    await db.exec('set role anon')
    await assert.rejects(()=>db.query('select public.charge_form_ingress($1)',[form]),/permission denied/)
    await db.exec('reset role; set role service_role')
    assert.equal((await db.query('select public.charge_form_ingress($1) result',[form])).rows[0].result,'ok')
    await db.exec('reset role')
    await db.query('update public.website_form_ingress_windows set count=300 where form_id=$1',[form])
    assert.equal((await db.query('select public.charge_form_ingress($1) result',[form])).rows[0].result,'rate_limited')
    await db.query("update public.website_form_ingress_windows set started_at=now()-interval '11 minutes' where form_id=$1",[form])
    assert.equal((await db.query('select public.charge_form_ingress($1) result',[form])).rows[0].result,'ok')
    const accept=()=>db.query("select public.accept_website_form($1,$2,'example.com','{}') result",[form,newId])
    assert.equal((await accept()).rows[0].result.ok,true)
    assert.equal((await accept()).rows[0].result.duplicate,true)
    assert.equal((await db.query("select count(*)::int n from public.website_form_delivery_jobs where kind='response'")).rows[0].n,1)
    await db.query("update public.websites set fqdn='new.example.com' where id=$1",[site])
    assert.equal((await db.query('select active from public.website_forms where id=$1',[form])).rows[0].active,false)
    assert.equal((await db.query("select verified_at from public.website_form_hosts where website_id=$1",[site])).rows[0].verified_at,null)
    assert.equal((await db.query('select count(*)::int n from public.website_form_responses')).rows[0].n,1)
    await assert.rejects(()=>db.query('delete from public.websites where id=$1',[site]),/Delete or export collected/)
    const retained=(await db.query('select id from public.website_form_responses where form_id=$1',[form])).rows[0].id
    await identity(owner)
    await db.query('select public.delete_website_form_response($1,$2,$3)',[site,form,retained])
    await db.exec('reset role')
    await db.query('delete from public.websites where id=$1',[site])
    assert.equal((await db.query('select count(*)::int n from public.website_forms')).rows[0].n,0)
    await db.exec(await readFile(new URL('../rollbacks/20261122000000_forms_disable.sql',import.meta.url),'utf8'))
    assert.equal((await db.query("select has_function_privilege('service_role','public.accept_website_form(uuid,uuid,text,jsonb)','execute') allowed")).rows[0].allowed,false)
    assert.equal((await db.query("select has_function_privilege('service_role','public.charge_form_client(text)','execute') allowed")).rows[0].allowed,false)
    const restore=await readFile(new URL('../rollbacks/20261122000000_forms_restore.sql',import.meta.url),'utf8')
    await assert.rejects(()=>db.exec(restore),/forms_host_challenge_quota_required/)
    await db.exec('rollback')
    assert.equal((await db.query("select has_function_privilege('service_role','public.accept_website_form(uuid,uuid,text,jsonb)','execute') allowed")).rows[0].allowed,false)
    await db.exec(await readFile(new URL('../migrations/20261128000000_forms_host_challenge_quota.sql',import.meta.url),'utf8'))
    await db.exec(restore)
    assert.equal((await db.query("select has_function_privilege('service_role','public.accept_website_form(uuid,uuid,text,jsonb)','execute') allowed")).rows[0].allowed,true)
    assert.equal((await db.query("select has_function_privilege('service_role','public.charge_form_client(text)','execute') allowed")).rows[0].allowed,true)
  } finally {await db.close()}
})
