import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('host challenge quotas retain owner, proof, retry and staged regrant semantics', async () => {
  const db = new PGlite()
  const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', site2='00000000-0000-0000-0000-000000000004'
  const identity = async id => { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,is_anonymous:false})]) }
  const start = async (id, hostname) => (await db.query('select public.begin_form_host_verification($1,$2) result',[id,hostname])).rows[0].result
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql','20261122000200_forms_host_verification.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
    // Model the proposed 002 staging hold; the follow-up installs the safe
    // function and intentionally restores the two owner-authenticated grants.
    await db.exec('revoke execute on function public.begin_form_host_verification(uuid,text), public.form_host_challenge(uuid) from authenticated')
    await db.exec(await readFile(new URL('../migrations/20261122000300_forms_management.sql',import.meta.url),'utf8'))
    await db.exec('revoke execute on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]), public.set_website_form_response_status(uuid,uuid,uuid,text) from authenticated')
    for (const file of ['20261122000400_forms_notifications.sql','20261122000500_forms_response_deletion.sql','20261122000600_forms_rename_safety.sql','20261122000700_forms_ingress_gate.sql','20261122000800_forms_uncertain_retry.sql','20261122000900_forms_client_admission.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
    const migration=await readFile(new URL('../migrations/20261128000000_forms_host_challenge_quota.sql',import.meta.url),'utf8')
    await assert.rejects(()=>db.exec(`begin; ${migration} select 1/0; commit;`),/division by zero/)
    await db.exec('rollback')
    const held=(await db.query("select to_regclass('public.website_form_host_challenge_windows') is null absent,has_function_privilege('authenticated','public.begin_form_host_verification(uuid,text)','execute') allowed")).rows[0]
    assert.deepEqual(held,{absent:true,allowed:false})
    await db.exec(`begin; ${migration} commit;`)
    const acl=(await db.query("select has_function_privilege('anon','public.begin_form_host_verification(uuid,text)','execute') a,has_function_privilege('authenticated','public.begin_form_host_verification(uuid,text)','execute') b,has_function_privilege('authenticated','public.form_host_challenge(uuid)','execute') c,has_function_privilege('authenticated','public.complete_form_host_verification(uuid,text)','execute') d,has_function_privilege('service_role','public.complete_form_host_verification(uuid,text)','execute') e")).rows[0]
    assert.deepEqual(acl,{a:false,b:true,c:true,d:false,e:true})
    const staged=(await db.query("select has_function_privilege('authenticated','public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])','execute') save,has_function_privilege('authenticated','public.set_website_form_response_status(uuid,uuid,uuid,text)','execute') status")).rows[0]
    assert.deepEqual(staged,{save:false,status:false})
    await db.query('insert into auth.users values($1),($2)',[owner,other])
    await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$3,'example.com'),($2,$3,'example.org')",[site,site2,owner])
    await identity(other); await assert.rejects(()=>start(site,'www.example.com'),/Website not found/)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:true})]);await assert.rejects(()=>start(site,'www.example.com'),/Website not found/)
    await db.exec('reset role; set role anon'); await assert.rejects(()=>start(site,'www.example.com'),/permission denied/)
    await identity(owner)
    await assert.rejects(()=>db.query('select * from public.website_form_host_challenge_windows'),/permission denied/)
    await assert.rejects(()=>db.query('delete from public.website_form_host_challenge_windows'),/permission denied/)
    const first=await start(site,'www.example.com'); const token=first.txt_value.slice('htp-verification='.length); const hash=createHash('sha256').update(token).digest('hex')
    await db.exec('reset role; set role service_role'); assert.equal((await db.query('select public.complete_form_host_verification($1,$2) ok',[first.host_id,hash])).rows[0].ok,true)
    await identity(owner); const second=await start(site,'www.example.com'); assert.equal(second.host_id,first.host_id);assert.notEqual(second.txt_value,first.txt_value)
    await db.exec('reset role; set role service_role');assert.equal((await db.query('select public.complete_form_host_verification($1,$2) ok',[first.host_id,hash])).rows[0].ok,false)
    await db.exec('reset role'); await db.query("update public.website_form_hosts set created_at=now()-interval '2 days' where id=$1",[first.host_id]); const secondHash=createHash('sha256').update(second.txt_value.slice('htp-verification='.length)).digest('hex')
    await db.exec('set role service_role');assert.equal((await db.query('select public.complete_form_host_verification($1,$2) ok',[first.host_id,secondHash])).rows[0].ok,false)
    await db.exec('reset role');await db.exec("insert into public.website_form_hosts(website_id,hostname,challenge_hash,verified_at) select '00000000-0000-0000-0000-000000000003', 'host'||i||'.example.com','old',now() from generate_series(1,63) i")
    await identity(owner);await assert.rejects(()=>start(site,'overflow.example.com'),/form_host_limit/)
    await db.exec('reset role');await db.query("insert into public.website_form_hosts(website_id,hostname,challenge_hash,verified_at) values($1,'legacy-overlimit.example.com','old',now())",[site]);await identity(owner)
    await assert.rejects(()=>start(site,'still-overflow.example.com'),/form_host_limit/)
    // Existing hosts can still be rotated at (or above) the cap.
    const rotated=await start(site,'host1.example.com');assert.ok(rotated.txt_value)
    await db.exec('reset role');await db.query("update public.website_form_host_challenge_windows set started_at=now(),count=59 where owner_id=$1",[owner])
    await identity(owner);await start(site2,'new.example.org');await assert.rejects(()=>start(site,'host2.example.com'),/form_host_rate_limited/)
    await db.exec('reset role');assert.ok((await db.query("select verified_at is not null verified from public.website_form_hosts where website_id=$1 and hostname='host2.example.com'",[site])).rows[0].verified)
    await db.query("update public.website_form_host_challenge_windows set started_at=now()-interval '11 minutes' where owner_id=$1",[owner]);await identity(owner);assert.ok((await start(site,'host2.example.com')).txt_value)
    await db.exec('reset role')
    await db.query("insert into public.websites(id,owner_id,fqdn) values('00000000-0000-0000-0000-000000000010',$1,'a.example.net'),('00000000-0000-0000-0000-000000000011',$1,'b.example.net'),('00000000-0000-0000-0000-000000000012',$1,'c.example.net')",[owner])
    await db.exec("insert into public.website_form_hosts(website_id,hostname,challenge_hash) select (case when i<=64 then '00000000-0000-0000-0000-000000000010' when i<=128 then '00000000-0000-0000-0000-000000000011' else '00000000-0000-0000-0000-000000000012' end)::uuid, 'account'||i||'.example.net','old' from generate_series(1,190) i")
    await identity(owner);await assert.rejects(()=>start(site2,'account-overflow.example.org'),/form_host_account_limit/)
    // Preexisting hosts remain usable even after the account cap is reached.
    assert.ok((await start(site2,'new.example.org')).txt_value)
  } finally { await db.close() }
})
