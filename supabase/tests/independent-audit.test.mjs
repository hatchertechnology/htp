import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

test('independent evidence retains bytes and isolates website ownership', async () => {
 const db = new PGlite()
 const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003'
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon;`)
  await db.exec(await readFile(new URL('../migrations/20261028142440_create_websites.sql', import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261031053344_seosmith_audits.sql', import.meta.url),'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261124000000_independent_audit_comparisons.sql', import.meta.url),'utf8'))
  await db.query('insert into auth.users values ($1),($2)',[owner,other]); await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  const identity=async (id, anon=false)=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,is_anonymous:anon})])}
  const readFileSyncRollback = await readFile(new URL('../rollbacks/20261124000000_independent_audit_comparisons.sql', import.meta.url),'utf8')
  const source='url,rule,state\r\nhttps://example.com/,missing_title,present\r\n'
  const save=()=>db.query('select public.import_independent_audit($1,$2,$3,$4) as receipt',[site,'controlled-csv-v1',source,{tool:'controlled'}])
  await identity(other); await assert.rejects(save,/forbidden/); await assert.rejects(()=>db.query('select public.independent_audit_history($1,null)',[site]),/forbidden/)
  await identity(owner,true); await assert.rejects(save,/forbidden/)
  await identity(owner); const receipt=(await save()).rows[0].receipt
  assert.equal(receipt.source_sha256,createHash('sha256').update(source).digest('hex'))
  const detail=(await db.query('select public.independent_audit_history($1,$2) as detail',[site,receipt.id])).rows[0].detail
  assert.equal(detail.source_text,source); assert.equal(detail.metadata.tool,'controlled')
  await assert.rejects(()=>db.query('select * from public.independent_audit_imports'),/permission denied/)
  await assert.rejects(()=>db.query('select public.save_independent_comparison($1,$2,$3,true)',[site,receipt.id,other]),/invalid_comparison/)
  await db.exec('reset role'); await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,repeat('a',64),'{}')",[other,site]); await identity(owner)
  const comparison=(await db.query('select public.save_independent_comparison($1,$2,$3,true) as c',[site,receipt.id,other])).rows[0].c
  assert.equal((await db.query('select public.independent_comparison_history($1) as history',[site])).rows[0].history.items[0].unmodified_v1_asserted,true)
  await identity(other); await assert.rejects(()=>db.query('select public.independent_comparison_history($1)',[site]),/forbidden/); await identity(owner)
  await assert.rejects(()=>db.query('select public.import_independent_audit($1,$2,$3,$4)',[site,'unknown',source,{}]),/invalid_import/)
  const importText = text => db.query('select public.import_independent_audit($1,$2,$3,$4)',[site,'controlled-csv-v1',text,{}])
  await assert.rejects(()=>importText('url,rule,state\na,b,maybe'),/invalid_csv/)
  await assert.rejects(()=>importText('url,rule,state\na,b,present\na,b,absent'),/duplicate_observation/)
  await assert.rejects(()=>importText('url,rule,state\n"unterminated'),/invalid_csv/)
  await assert.rejects(()=>importText('url,rule,state\n' + Array.from({length:34},(_,i)=>`${'a'.repeat(8000)}${i},r,unknown\n`).join('')),/csv_key_limit/)
  await importText('url,rule,state\n"https://example.com/?a=1,b=2",x,unknown')
  await importText('url,rule,state\n"https://example.com/line\nbreak",x,unknown')
  await importText(await readFile(new URL('../../apps/web/tests/fixtures/s15-controlled.csv', import.meta.url),'utf8'))
  await db.exec('reset role');
  await db.query(`insert into public.independent_audit_imports(website_id,fqdn,format,source_text,source_sha256,metadata,created_at) select $1,'example.com','controlled-csv-v1','url,rule,state',repeat('a',64),'{}', '2020-01-01'::timestamptz from generate_series(1,101)`,[site]); await identity(owner)
  const page1=(await db.query('select public.independent_audit_history($1,null) as h',[site])).rows[0].h
  assert.equal(page1.items.length,100); assert(page1.next_cursor)
  const page2=(await db.query('select public.independent_audit_history($1,null,$2,$3) as h',[site,page1.next_cursor.before,page1.next_cursor.before_id])).rows[0].h
  assert.equal(page2.items.length,5); assert.equal(new Set([...page1.items,...page2.items].map(x=>x.id)).size,105)
  await assert.rejects(()=>db.query('select public.independent_audit_history($1,null,now(),null)',[site]),/invalid_cursor/)
  await db.exec('reset role'); await assert.rejects(()=>db.exec(readFileSyncRollback),/independent_evidence_not_empty/); await db.exec('rollback'); await assert.rejects(()=>db.query('delete from public.websites where id=$1',[site]),/foreign key/); await assert.rejects(()=>db.query('delete from auth.users where id=$1',[owner]),/foreign key/)
  await db.query("update public.websites set fqdn='other.example.com' where id=$1",[site]); await identity(owner)
  assert.equal((await db.query('select public.independent_audit_history($1,$2) as history',[site,receipt.id])).rows[0].history.fqdn,'example.com')
  const replay=(await db.query('select public.independent_comparison_detail($1,$2) as d',[site,comparison.id])).rows[0].d
  assert.equal(replay.source.source_text,source); assert.equal(replay.comparison.fqdn,'example.com'); assert.equal(replay.seosmith.delivery_id,other)
  const fingerprint=(await db.query('select public.independent_evidence_fingerprint($1) as f',[site])).rows[0].f
  await assert.rejects(()=>db.query('select public.delete_independent_audit_evidence($1,$2,$3)',[site,'wrong',fingerprint]),/confirmation_required/)
  await identity(other); await assert.rejects(()=>db.query('select public.independent_comparison_detail($1,$2)',[site,comparison.id]),/forbidden/); await assert.rejects(()=>db.query('select public.delete_independent_audit_evidence($1,$2,$3)',[site,'DELETE INDEPENDENT EVIDENCE',fingerprint]),/forbidden/); await identity(owner)
  await importText('url,rule,state\nhttps://example.com/new,missing_title,unknown')
  await assert.rejects(()=>db.query('select public.delete_independent_audit_evidence($1,$2,$3)',[site,'DELETE INDEPENDENT EVIDENCE',fingerprint]),/evidence_changed_export_again/)
  const fresh=(await db.query('select public.independent_evidence_fingerprint($1) as f',[site])).rows[0].f
  const deleted=(await db.query('select public.delete_independent_audit_evidence($1,$2,$3) as d',[site,'DELETE INDEPENDENT EVIDENCE',fresh])).rows[0].d
  assert.equal(deleted.comparisons_deleted,1); assert.equal(deleted.imports_deleted,106)
  await db.exec('reset role'); await db.query('delete from auth.users where id=$1',[owner]);
  assert.equal((await db.query('select count(*)::int as n from public.websites where id=$1',[site])).rows[0].n,0)
  await db.exec('reset role'); await db.exec(await readFile(new URL('../rollbacks/20261124000000_independent_audit_comparisons.sql', import.meta.url),'utf8'))
  assert.equal((await db.query("select to_regclass('public.independent_audit_imports') as name")).rows[0].name,null)
 } finally { await db.close() }
})
