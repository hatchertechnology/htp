import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('export access checks owner, anonymous status, site and delivery on every call', async () => {
  const db = new PGlite()
  const owner = '00000000-0000-0000-0000-000000000001'
  const other = '00000000-0000-0000-0000-000000000002'
  const site = '00000000-0000-0000-0000-000000000003'
  const run = '00000000-0000-0000-0000-000000000004'
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create table public.websites(id uuid primary key, owner_id uuid, fqdn text);
      create table public.seosmith_audits(delivery_id uuid primary key, website_id uuid, fqdn text);
      grant usage on schema public,auth to authenticated,anon;`)
    await db.exec(await readFile(new URL('../migrations/20261117013057_audit_export_access.sql', import.meta.url), 'utf8'))
    await db.query('insert into public.websites values ($1,$2,$3)', [site, owner, 'example.test'])
    await db.query('insert into public.seosmith_audits values ($1,$2,$3)', [run, site, 'example.test'])
    const identity = async (sub, isAnonymous) => db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub, is_anonymous: isAnonymous })])
    const check = async () => (await db.query('select public.seosmith_audit_export_access($1,$2) as allowed', [site, run])).rows[0].allowed
    assert.equal((await db.query("select has_function_privilege('anon','public.seosmith_audit_export_access(uuid,uuid)','execute') as allowed")).rows[0].allowed, false)
    await db.exec('set role authenticated')
    await identity(owner, false); assert.equal(await check(), true)
    await identity(other, false); assert.equal(await check(), false)
    await identity(owner, true); assert.equal(await check(), false)
    await identity(owner, false); await db.exec('reset role')
    await db.query('update public.websites set fqdn=$1 where id=$2', ['different.test', site])
    await db.exec('set role authenticated'); assert.equal(await check(), false)
    await db.exec('reset role'); await db.query('update public.websites set fqdn=$1 where id=$2', ['example.test', site])
    await db.query('delete from public.seosmith_audits where delivery_id=$1', [run])
    await db.exec('set role authenticated'); assert.equal(await check(), false)
    await db.exec('reset role'); await db.query('insert into public.seosmith_audits values ($1,$2,$3)', [run, site, 'example.test'])
    await db.query('update public.websites set owner_id=$1 where id=$2', [other, site])
    await db.exec('set role authenticated'); assert.equal(await check(), false)
    await identity(other, false); assert.equal(await check(), true)
    await db.exec('reset role'); await db.query('delete from public.websites where id=$1', [site])
    await db.exec('set role authenticated'); assert.equal(await check(), false)
  } finally { await db.close() }
})
