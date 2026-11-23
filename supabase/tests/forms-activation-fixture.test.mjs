import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('fixture grants and rolls back only host proof without erasing hosts or opening other holds', async () => {
  const db = new PGlite()
  const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003'
  const held=['begin_form_host_verification(uuid,text)','form_host_challenge(uuid)','save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])','set_website_form_response_status(uuid,uuid,uuid,text)','request_form_recipient(uuid,uuid,text)','disable_form_recipient(uuid,uuid,uuid)','retry_form_delivery(uuid,uuid,uuid)','delete_website_form_response(uuid,uuid,uuid)']
  const sql = name => readFile(new URL(`./fixtures/forms-activation/${name}.sql`,import.meta.url),'utf8')
  const acl=async()=>Promise.all(held.map(async name=>(await db.query("select has_function_privilege('authenticated',$1,'execute') allowed",[`public.${name}`])).rows[0].allowed))
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
    for(const file of ['20261028142440_create_websites.sql','20261122000000_website_forms.sql','20261122000100_forms_acceptance.sql','20261122000200_forms_host_verification.sql','20261122000300_forms_management.sql','20261122000400_forms_notifications.sql','20261122000500_forms_response_deletion.sql','20261122000600_forms_rename_safety.sql','20261122000700_forms_ingress_gate.sql','20261122000800_forms_uncertain_retry.sql','20261122000900_forms_client_admission.sql','20261128000000_forms_host_challenge_quota.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'))
    for(const name of held) await db.exec(`revoke execute on function public.${name} from public,anon,authenticated`)
    await db.query('insert into auth.users values($1),($2)',[owner,other]);await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
    const regrant=await sql('host-proof-regrant'), rollback=await sql('host-proof-rollback')
    await assert.rejects(()=>db.exec(regrant),/fixture_only/);await db.exec('rollback')
    await db.exec("select set_config('forms.activation_fixture','disposable',false)")
    await db.exec('grant execute on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]) to authenticated')
    await assert.rejects(()=>db.exec(regrant),/held_privilege_drift/);await db.exec('rollback')
    assert.deepEqual(await acl(),[false,false,true,false,false,false,false,false])
    await db.exec('revoke execute on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]) from authenticated')
    await db.exec(regrant);assert.deepEqual(await acl(),[true,true,false,false,false,false,false,false])
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:other,is_anonymous:false})])
    await assert.rejects(()=>db.query("select public.begin_form_host_verification($1,'www.example.com')",[site]),/Website not found/)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
    const result=(await db.query("select public.begin_form_host_verification($1,'www.example.com') result",[site])).rows[0].result;assert.ok(result.host_id)
    await db.exec('reset role');await db.exec(rollback);assert.deepEqual(await acl(),Array(8).fill(false))
    assert.equal((await db.query('select count(*)::int n from public.website_form_hosts where website_id=$1',[site])).rows[0].n,1)
    await assert.rejects(()=>db.exec(rollback),/host_grant_drift/);await db.exec('rollback')
  } finally { await db.close() }
})
