#!/usr/bin/env node
// Isolated PGlite regression probe of an exact merged backend revision. No
// network, credentials, deployed database, or host runtime. Requires that
// backend checkout's already installed pinned supabase test dependency.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { profile } from './provider-request-contract.mjs';
const args=process.argv.slice(2);
assert.ok(args.length===2 && args[0]==='--backend-root','usage: node scripts/probe-provider-business-locations.mjs --backend-root /path/to/backend');
const root=resolve(args[1]), revision=profile.backendEvidence.mergeRevision;
assert.match(revision,/^[0-9a-f]{40}$/);
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:4*1024*1024});
const require=createRequire(resolve(root,'supabase/package.json'));
const { PGlite }=require('@electric-sql/pglite');
const db=new PGlite(), owner='00000000-0000-4000-8000-000000000001', site='00000000-0000-4000-8000-000000000003';
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth,public to authenticated,anon,service_role;`);
  const migrations=git('ls-tree','-r','--name-only',revision,'supabase/migrations').trim().split('\n').filter(p=>p.endsWith('.sql')).sort();
  assert.ok(migrations.length>0,'migration inventory required');
  for (const path of migrations) await db.exec(git('show',`${revision}:${path}`));
  // Explicitly enable this feature only inside this disposable database, as in
  // the backend test fixture, to exercise source validation rather than pause.
  await db.exec(`insert into auth.users values('${owner}');
    insert into public.websites(id,owner_id,fqdn) values('${site}','${owner}','example.com');
    create or replace function public.business_profile_enabled() returns boolean language sql immutable set search_path='' as $$ select true $$;
    set role authenticated;`);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})]);
  const register=async(key,property)=>(await db.query("select public.register_provider_report_request($1,$2,'business_locations',$3,null,null) r",[site,key,property])).rows[0].r;
  const lookup=async(key)=>(await db.query('select public.get_provider_report_request($1,$2) r',[site,key])).rows[0].r;
  assert.deepEqual(await register('new-nonempty','123'),{code:'INVALID_ARGUMENT'});
  assert.deepEqual(await lookup('new-nonempty'),{code:'NOT_FOUND'});
  const empty=await register('empty','');
  assert.equal(empty.collection.status,'accepted');
  assert.deepEqual(empty.collection.association,{provider:'google',kind:'business_locations',fqdn:'example.com',propertyId:'',startDate:'1970-01-01',endDate:'1970-01-01'});
  assert.deepEqual(await register('empty',''),empty);
  assert.deepEqual(await register('empty','123'),{code:'CONFLICT'});
  assert.deepEqual(await lookup('empty'),empty);
  const nullProperty=await register('null-property',null);
  assert.equal(nullProperty.collection.association.propertyId,'');
  assert.deepEqual(await register('null-property',''),nullProperty);
  await db.exec('reset role');
  const counts=(await db.query('select (select count(*)::int from public.provider_report_requests) intents,(select count(*)::int from public.google_report_jobs) jobs')).rows[0];
  assert.deepEqual(counts,{intents:2,jobs:1});
  console.log(JSON.stringify({backendRevision:revision,migrations:migrations.length,newNonempty:'INVALID_ARGUMENT',changedExisting:'CONFLICT',acceptedProperty:'',nullCoalescesToEmpty:true,originalRetained:true,...counts,scope:'isolated PGlite; not hosted/provider/host acceptance'}));
} finally { await db.close(); }
