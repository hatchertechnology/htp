import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('forms isolate owner reads, prevent public writes and preserve responses on deletion', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon;`)
    for (const file of ['20261028142440_create_websites.sql', '20261122000000_website_forms.sql']) {
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
