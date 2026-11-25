import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { buildReport, buildSummary, REVISION } from '../../scripts/s14-schema4-native/gen.mjs'

const hash = v => createHash('sha256').update(v).digest('hex')
const owner = '00000000-0000-0000-0000-000000000001'
const site = '00000000-0000-0000-0000-000000000003'
const TOKEN = 'x'.repeat(64), MIGRATION = '20261212000000_s14_schema4_evidence.sql'
const migrations = new URL('../migrations/', import.meta.url)
const files = (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()
const COMPARISON = hash('receiver-v5-comparison-key')

async function boot(stopBefore) {
  const db = new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    alter default privileges grant execute on functions to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`)
  const list = stopBefore ? files.slice(0, files.indexOf(MIGRATION)) : files.slice(0, files.indexOf(MIGRATION) + 1)
  for (const f of list) await db.exec(await readFile(new URL(f, migrations), 'utf8'))
  await db.query('insert into auth.users values($1)', [owner])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')", [site, owner])
  await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)', [site, hash(TOKEN)])
  return db
}
const as = (db, role) => db.exec(`reset role;set role ${role}`)
// The schema-4 summary carries the receiver v5 comparison_key; gen.mjs's synthetic summary omits it.
const withKey = (report, key = COMPARISON) => JSON.stringify({ ...JSON.parse(buildSummary(report)), comparison_key: key })
function fixture(mutate = () => {}, { evidence = true, key } = {}) {
  const id = randomUUID()
  const report = buildReport({ requestId: id, websiteId: site, pages: 3, observed: 3, evidence })
  mutate(report)
  const raw = JSON.stringify(report)
  return { id, report, raw, sha: hash(raw), summary: withKey(report, key), rev: REVISION }
}
const later = (r, finished) => { r.finished_at = finished; if (r.evidence_contract) r.evidence_contract.observed_at.finished_at = finished }
const commit = (db, f) => db.query('select public.commit_seosmith_audit_v4($1,$2,$3,$4,$5,$6) as r', [TOKEN, f.id, f.sha, f.raw, f.summary, f.rev]).then(r => r.rows[0].r)
const indexed = (db, id) => db.query('select * from public.seosmith_lifecycle_indexed where delivery_id=$1', [id]).then(r => r.rows[0])
const expectedKey = (report, key = COMPARISON) => hash(`${key}\nschema:4\n${report.evidence_contract.comparison_key}`)

test('schema 4 with evidence is indexed_v1 with the helper comparison key and the S2 evidence rows', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'service_role'); await commit(db, f); await as(db, 'postgres')
    const i = await indexed(db, f.id)
    assert.equal(i.state, 'indexed_v1')
    assert.equal(i.schema_version, '4')
    assert.equal(i.comparison_key, expectedKey(f.report))
    assert.equal(i.policy_digest, f.report.evidence_contract.policy.signature)
    assert.equal(i.engine_version, f.report.engine_version)
    assert.equal(i.ruleset_version, f.report.ruleset_version)
    assert.equal(i.evidence_truncated, f.report.evidence_contract.truncated)
    const n = t => db.query(`select count(*)::int n from public.${t} where delivery_id=$1`, [f.id]).then(r => r.rows[0].n)
    assert.equal(await n('seosmith_lifecycle_evaluations'), f.report.evidence_contract.evaluations.length)
    assert.equal(await n('seosmith_lifecycle_observations'), f.report.evidence_contract.observations.length)
    // The SQL helper equals the plan's formula; schema-2 key is untouched by it.
    const h = await db.query('select public.seosmith_s14_comparison_key(a) k from public.seosmith_audits a where delivery_id=$1', [f.id])
    assert.equal(h.rows[0].k, i.comparison_key)
    await assert.rejects(() => as(db, 'authenticated').then(() => db.query('select public.seosmith_s14_comparison_key(a) from public.seosmith_audits a')), /permission denied/)
  } finally { await db.close() }
})

test('schema 4 without evidence is unsupported and never enqueued', async () => {
  const db = await boot()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true')
    const f = fixture(() => {}, { evidence: false })
    await as(db, 'service_role'); await commit(db, f); await as(db, 'postgres')
    const i = await indexed(db, f.id)
    assert.equal(i.state, 'unsupported'); assert.equal(i.comparison_key, null)
    assert.equal((await db.query('select count(*)::int n from public.audit_event_jobs')).rows[0].n, 0)
  } finally { await db.close() }
})

test('a schema-4 row whose summary lacks the comparison key is unsupported, not indexed with a null key', async () => {
  const db = await boot()
  try {
    const f = fixture(() => {}); f.summary = buildSummary(f.report) // no comparison_key
    await as(db, 'service_role'); await commit(db, f); await as(db, 'postgres')
    assert.equal((await indexed(db, f.id)).state, 'unsupported')
  } finally { await db.close() }
})

test('invalid evidence (bad pointer, reordered finding) is evidence_invalid and nothing is stored', async () => {
  const db = await boot()
  try {
    await as(db, 'service_role')
    const swap = fixture(r => { [r.findings[0], r.findings[1]] = [r.findings[1], r.findings[0]] })
    await assert.rejects(() => commit(db, swap), e => e.code === '22023' && /evidence_invalid/.test(e.message) && /invalid_evidence/.test(e.detail))
    const ptr = fixture(r => { r.evidence_contract.evaluations[0].source_locator = '/findings/999' })
    await assert.rejects(() => commit(db, ptr), e => /evidence_invalid/.test(e.message))
    await as(db, 'postgres')
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits')).rows[0].n, 0)
    assert.equal((await db.query('select count(*)::int n from public.seosmith_lifecycle_indexed')).rows[0].n, 0)
  } finally { await db.close() }
})

test('enqueue fires for schema 4 only with enqueue_enabled and evidence version 1 from the report', async () => {
  const db = await boot()
  try {
    const jobs = () => db.query('select count(*)::int n from public.audit_event_jobs').then(r => r.rows[0].n)
    await as(db, 'service_role')
    const off = fixture(); await commit(db, off)
    await as(db, 'postgres'); assert.equal(await jobs(), 0)
    await db.exec('update public.audit_event_config set enqueue_enabled=true'); await as(db, 'service_role')
    const on = fixture(); await commit(db, on)
    const bare = fixture(() => {}, { evidence: false }); await commit(db, bare)
    await as(db, 'postgres')
    // Schema-4 summary has no evidence_contract_version of its own that the trigger relies on.
    assert.equal((await db.query('select summary->>$2 v from public.seosmith_audits where delivery_id=$1', [on.id, 'schema_version'])).rows[0].v, '4')
    assert.deepEqual((await db.query('select delivery_id from public.audit_event_jobs')).rows, [{ delivery_id: on.id }])
    // The version is read from report.evidence_contract.version, not the summary.
    const stray = fixture(); stray.summary = JSON.stringify({ ...JSON.parse(stray.summary), evidence_contract_version: 9 })
    await as(db, 'service_role'); await commit(db, stray); await as(db, 'postgres')
    assert.equal(await jobs(), 2)
  } finally { await db.close() }
})

test('seosmith_remediation_save accepts a schema-4 finding; list/attempt are unchanged and the hold ACL is kept', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'service_role'); await commit(db, f); await as(db, 'postgres')
    // The hold is preserved by create or replace: still no execute for any API role.
    for (const role of ['anon', 'authenticated', 'service_role'])
      assert.equal((await db.query("select has_function_privilege($1,'public.seosmith_remediation_save(uuid,uuid,integer,jsonb)','execute') a", [role])).rows[0].a, false, role)
    // Synthetic authorization only (the migration keeps it held).
    await db.exec('grant execute on function public.seosmith_remediation_save(uuid,uuid,integer,jsonb) to authenticated')
    await db.exec('reset role;set role authenticated')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, is_anonymous: false })])
    const w = (await db.query('select public.seosmith_remediation_save($1,$2,0,$3) as w', [site, f.id, { status: 'open' }])).rows[0].w
    assert.equal(w.finding_key, f.report.findings[0].key); assert.equal(w.finding_index, 0)
    await assert.rejects(() => db.query('select public.seosmith_remediation_save($1,$2,999,$3)', [site, f.id, {}]), /invalid_audit_or_finding/)
  } finally { await db.close() }
})

// N2/N3 cross-checks. Processing runs in one READ COMMITTED transaction: lock, claim, process.
const processNext = db => db.transaction(async tx => {
  await tx.query('select public.audit_event_snapshot_lock()')
  const c = (await tx.query('select public.audit_event_claim() c')).rows[0].c
  if (!c) return null
  return (await tx.query('select public.audit_event_process($1,$2) r', [c.delivery_id, c.lease_token])).rows[0].r
})

test('two schema-4 rows in one generation share the helper key and produce one processor event', async () => {
  const db = await boot()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
    const a = fixture(r => later(r, '2026-11-25T10:00:00Z'))
    const b = fixture(r => { later(r, '2026-11-25T11:00:00Z'); r.findings[0].severity = 'critical' })
    await as(db, 'service_role'); await commit(db, a); await commit(db, b); await as(db, 'postgres')
    const [ia, ib] = [await indexed(db, a.id), await indexed(db, b.id)]
    assert.equal(ia.comparison_key, ib.comparison_key)
    assert.equal(ia.policy_digest, ib.policy_digest)
    assert.equal(await processNext(db), 'held')           // first receipt has no baseline: n<2 at its turn is history_unknown
    assert.equal(await processNext(db), 'processed')
    const ev = (await db.query('select kind,severity,delivery_id,baseline_id from public.audit_events')).rows
    assert.equal(ev.length, 1)
    assert.deepEqual(ev[0], { kind: 'severity_increased', severity: 'critical', delivery_id: b.id, baseline_id: a.id })
    // After the fact the shared-key rows are what an E-web compatible() comparison sees.
    assert.equal(ia.schema_version, '4'); assert.equal(ib.schema_version, '4')
  } finally { await db.close() }
})

test('a generation holding schema 2 and schema 4 is history_unknown; a generation bump processes the schema-4 pair', async () => {
  const db = await boot()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
    const v2 = JSON.parse(await readFile(new URL('./fixtures/contracts/v2-complete.json', import.meta.url), 'utf8'))
    // A schema-2 receipt in generation 1 (direct insert, as the pre-cutover receiver stored it).
    const old = randomUUID()
    await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,summary,ingestion_source,scan_at) values($1,$2,'example.com',1,$3,$4,$5,'worker','2026-11-25T09:00:00Z')",
      [old, site, 'd'.repeat(64), v2, { schema_version: 2, comparison_key: COMPARISON }])
    await db.query('delete from public.audit_event_jobs')
    const a = fixture(r => later(r, '2026-11-25T10:00:00Z')), b = fixture(r => later(r, '2026-11-25T11:00:00Z'))
    await as(db, 'service_role'); await commit(db, a); await commit(db, b); await as(db, 'postgres')
    assert.equal(await processNext(db), 'held'); assert.equal(await processNext(db), 'held')
    // The newest schema-4 receipt sees schema-2 history with a different comparison key.
    assert.equal((await db.query("select hold_reason from public.audit_event_jobs where delivery_id=$1", [b.id])).rows[0].hold_reason, 'history_unknown')
    // The 4b-0 generation bump: new rows are in generation 2, away from the schema-2 history.
    await db.query('update public.seosmith_bindings set generation=2 where website_id=$1', [site])
    const c = fixture(r => { later(r, '2026-11-25T12:00:00Z'); r.request.binding_generation = 2 }), d = fixture(r => { later(r, '2026-11-25T13:00:00Z'); r.request.binding_generation = 2; r.findings[1].severity = 'alert' })
    await as(db, 'service_role'); await commit(db, c); await commit(db, d); await as(db, 'postgres')
    assert.equal(await processNext(db), 'held')            // c has no baseline yet
    assert.equal(await processNext(db), 'processed')       // d vs c
    assert.equal((await db.query('select count(*)::int n from public.audit_events where delivery_id=$1', [d.id])).rows[0].n, 1)
  } finally { await db.close() }
})

test('replace is idempotent over the H2 state and keeps the existing ACLs', async () => {
  const before = await boot(true)
  try {
    const acl = async () => (await before.query(`select p.proname, p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('seosmith_index_lifecycle','audit_enqueue_receipt','seosmith_remediation_save') order by 1`)).rows
    const pre = await acl()
    await before.exec(await readFile(new URL(MIGRATION, migrations), 'utf8'))
    assert.deepEqual(await acl(), pre)
    await before.exec(await readFile(new URL(MIGRATION, migrations), 'utf8')) // re-run: create or replace only
  } finally { await before.close() }
})
