import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('indexed inspection observations are append-only, bounded and owner/hostname scoped', async () => {
  const db = new PGlite()
  const owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const migrations=new URL('../migrations/',import.meta.url)
    for (const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,migrations),'utf8'))
    await db.exec(`insert into auth.users values('${owner}'),('${other}'); insert into public.websites(id,owner_id,fqdn) values('${site}','${owner}','example.com')`)
    async function identity(user,anonymous=false) { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})]) }
    async function save(host='example.com',property='sc-domain:example.com',url='https://example.com/jobs/1',data={inspectionResult:{indexStatusResult:{verdict:'PASS'}}}) {
      return (await db.query('select public.save_search_inspection($1,$2,$3,$4,$5) as data',[site,host,property,url,data])).rows[0].data
    }
    async function history(before=null) { return (await db.query('select public.search_inspection_history($1,$2,$3,$4) as data',[site,'sc-domain:example.com','https://example.com/jobs/1',before])).rows[0].data }
    await identity(other); await assert.rejects(()=>save(),/Website not found/); await assert.rejects(()=>history(),/Website not found/)
    await identity(owner,true); await assert.rejects(()=>save(),/Website not found/); await assert.rejects(()=>history(),/Website not found/)
    await identity(owner)
    for (const args of [['old.example.com'],['example.com','sc-domain:evil.com'],['example.com','https://example.com/jobs/','https://example.com/admin'],['example.com','sc-domain:example.com','https://evil.com/jobs/1'],['example.com','sc-domain:example.com','https://example.com/jobs/1',{}]]) await assert.rejects(()=>save(...args),/Invalid indexed inspection/)
    await assert.rejects(()=>db.query('select * from public.search_inspection_observations'),/permission denied/)
    await assert.rejects(()=>db.query("update public.search_inspection_observations set data='{}'"),/permission denied/)
    await assert.rejects(()=>db.query('delete from public.search_inspection_observations'),/permission denied/)
    const first=await save(); const second=await save()
    assert.ok(second.id>first.id)
    assert.equal(first.provenance,'owner_submitted_indexed_inspection')
    assert.equal(first.mode,'indexed_version')
    for(let i=0;i<49;i++) await save()
    const page=await history()
    assert.equal(page.observations.length,50); assert.equal(page.has_more,true)
    assert.ok(page.observations[0].observed_at)
    const next=await history(page.next_before_id)
    assert.equal(next.observations.length,1); assert.equal(next.has_more,false)
    await db.exec("reset role; update public.websites set fqdn='renamed.example.com'")
    await identity(owner)
    assert.equal((await history()).observations.length,0)
    await assert.rejects(()=>save(),/Invalid indexed inspection/)
  } finally { await db.close() }
})
