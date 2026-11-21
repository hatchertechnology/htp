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
