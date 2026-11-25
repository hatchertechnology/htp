import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { buildReport, buildSummary, REVISION } from '../../scripts/s14-schema4-native/gen.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002'
const site = '00000000-0000-0000-0000-000000000003', site2 = '00000000-0000-0000-0000-000000000004'
const TOKEN = 'x'.repeat(64), MIGRATION = '20261211000000_s14_schema4_admission.sql'
const migrations = new URL('../migrations/', import.meta.url)
const files = (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()
const upTo = files.slice(0, files.indexOf(MIGRATION) + 1)

async function boot(stop) {
  const db = new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    alter default privileges grant execute on functions to anon,authenticated;`)
  for (const f of upTo.slice(0, upTo.indexOf(stop ?? '~') < 0 ? undefined : upTo.indexOf(stop))) await db.exec(await readFile(new URL(f, migrations), 'utf8'))
  await db.query('insert into auth.users values($1),($2)', [owner, other])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com'),($3,$2,'other.example')", [site, owner, site2])
  await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2),($3,$4)', [site, hash(TOKEN), site2, hash('y'.repeat(64))])
  return db
}
const as = (db, role) => db.exec(`reset role;set role ${role}`)
const owned = async db => {
  await db.exec('reset role;set role authenticated')
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, is_anonymous: false })])
}
const fixture = (over = {}, opts = {}) => {
  const requestId = over.requestId ?? randomUUID()
  const report = buildReport({ requestId, websiteId: site, pages: 6, observed: 3, ...opts })
  const raw = JSON.stringify(report)
  const summary = buildSummary(report)
  return { id: requestId, report, raw, summary, sha: hash(raw), rev: REVISION, ...over }
}
const commit = (db, f, token = TOKEN) => db.query('select public.commit_seosmith_audit_v4($1,$2,$3,$4,$5,$6) as r',
  [token, f.id, f.sha, f.raw, f.summary, f.rev]).then(r => r.rows[0].r)

test('commit returns the exact receipt, binds summary bytes and an identical retry is idempotent', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'service_role')
    const receipt = await commit(db, f)
    assert.deepEqual(receipt, { delivery_id: f.id, sha256: f.sha, accepted: true })
    assert.deepEqual(await commit(db, f), receipt)
    await as(db, 'postgres')
    const row = (await db.query('select * from public.seosmith_audits where delivery_id=$1', [f.id])).rows[0]
    assert.equal(row.summary_text, f.summary)
    assert.equal(row.summary_sha256, hash(f.summary))
    assert.equal(row.validator_revision, REVISION)
    assert.equal(row.raw_report_json, f.raw)
    assert.equal(row.ingestion_source, 'worker')
    assert.equal(Number(row.generation), 1)
    assert.deepEqual(row.summary, JSON.parse(f.summary))
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits where delivery_id=$1', [f.id])).rows[0].n, 1)
    // The lifecycle index (trigger) treats schema 4 as unsupported until the evidence migration.
    assert.equal((await db.query('select state from public.seosmith_lifecycle_indexed where delivery_id=$1', [f.id])).rows[0].state, 'unsupported')
  } finally { await db.close() }
})

test('a byte change on a committed delivery id is a 23505 conflict', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'service_role'); await commit(db, f)
    const changed = JSON.stringify(f.report) + ' '
    await assert.rejects(() => commit(db, { ...f, raw: changed, sha: hash(changed) }), e => e.code === '23505' && /delivery_conflict/.test(e.message))
  } finally { await db.close() }
})

test('wrong website, generation, FQDN, disabled binding, token and shape are rejected', async () => {
  const db = await boot()
  try {
    await as(db, 'service_role')
    const reject = (f, re, token) => assert.rejects(() => commit(db, f, token), re)
    const base = fixture()
    await reject(base, /invalid_worker/, 'z'.repeat(64))
    await reject(base, /invalid_delivery/, 'short')
    await reject({ ...base, sha: hash('other') }, /invalid_delivery/)
    const mutate = (fn, over = {}) => { const r = structuredClone(base.report); fn(r); const raw = JSON.stringify(r); return fixture({ id: base.id, raw, sha: hash(raw), summary: buildSummary(r), ...over }) }
    await reject(mutate(r => { r.request.website_id = site2 }), /invalid_binding_or_report/)
    await reject(mutate(r => { r.request.binding_generation = 2 }), /invalid_binding_or_report/)
    await reject(mutate(r => { r.request.url = 'https://other.example/' }), /invalid_binding_or_report/)
    await reject(mutate(r => { r.request.request_id = randomUUID() }), /invalid_binding_or_report/)
    await reject(mutate(r => { r.schema_version = 2 }), /invalid_binding_or_report/)
    await reject(mutate(r => { r.outcome = 'weird' }), /invalid_binding_or_report/)
    await reject(mutate(r => { r.pages = {} }), /invalid_binding_or_report/)
    await as(db, 'postgres'); await db.query('update public.seosmith_bindings set enabled=false where website_id=$1', [site]); await as(db, 'service_role')
    await reject(base, /invalid_worker/)
    await as(db, 'postgres'); await db.query('update public.seosmith_bindings set enabled=true,generation=2 where website_id=$1', [site]); await as(db, 'service_role')
    await reject(base, /invalid_binding_or_report/)
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits')).rows[0].n, 0)
  } finally { await db.close() }
})

test('a disabled or unknown revision rejects a new row but returns the receipt for a committed retry', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'service_role')
    const receipt = await commit(db, f)
    await db.query('update public.seosmith_s14_validators set enabled=false where revision=$1', [REVISION])
    assert.deepEqual(await commit(db, f), receipt)
    await assert.rejects(() => commit(db, fixture()), e => e.code === '55000' && /validator_disabled/.test(e.message))
    await db.query('update public.seosmith_s14_validators set enabled=true where revision=$1', [REVISION])
    await assert.rejects(() => commit(db, fixture({ rev: 's14-wire-1/unknown' })), /validator_disabled/)
    assert.equal((await commit(db, fixture())).accepted, true)
  } finally { await db.close() }
})

test('direct schema-4 inserts need matching sha, summary, raw/report pair, enabled revision and worker source', async () => {
  const db = await boot()
  try {
    await as(db, 'service_role')
    const insert = (f, over = {}) => {
      const v = { id: f.id, sha: f.sha, report: f.raw, raw: f.raw, summary: f.summary, ssha: hash(f.summary), rev: f.rev, source: 'worker', ...over }
      return db.query(`insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source,summary_text,summary_sha256,validator_revision)
        values($1,$2,'example.com',1,$3,$4::jsonb,$5,$6,$7,$8,$9)`, [v.id, site, v.sha, v.report, v.raw, v.source, v.summary, v.ssha, v.rev])
    }
    const f = fixture()
    await assert.rejects(() => insert(f, { sha: hash('x') }), /invalid_s14_binding/)
    await assert.rejects(() => insert(f, { ssha: hash('x') }), /invalid_s14_binding/)
    await assert.rejects(() => insert(f, { report: JSON.stringify({ ...f.report, outcome: 'partial' }) }), /invalid_s14_binding/)
    await assert.rejects(() => insert(f, { raw: f.raw + ' ' }), /invalid_s14_binding/)
    await assert.rejects(() => insert(f, { rev: 's14-wire-1/unknown' }), /violates foreign key|validator_disabled/)
    await assert.rejects(() => insert(f, { summary: '{"summary_version":4}', ssha: hash('{"summary_version":4}') }), /invalid_s14_summary/)
    await assert.rejects(() => insert(f, { summary: '[]', ssha: hash('[]') }), /invalid_s14_summary/)
    await assert.rejects(() => insert(f, { summary: '{', ssha: hash('{') }), /invalid input syntax|invalid_s14/)
    await assert.rejects(() => insert(f, { source: 'import' }), /invalid_s14_binding/)
    // Columns are all-or-nothing and tied to schema 4.
    await assert.rejects(() => db.query(`insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json)
      values($1,$2,'example.com',1,$3,$4::jsonb,$5)`, [f.id, site, f.sha, f.raw, f.raw]), /invalid_s14_binding|seosmith_audits_s14_columns/)
    await assert.rejects(() => insert(fixture(), { rev: null }), /invalid_s14_binding|seosmith_audits_s14_columns/)
    const legacy = JSON.parse(await readFile(new URL('fixtures/seosmith-expanded.json', import.meta.url), 'utf8'))
    legacy.request.website_id = site; legacy.request.request_id = randomUUID()
    const legacyRaw = JSON.stringify(legacy)
    await assert.rejects(() => db.query(`insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,summary_text,summary_sha256,validator_revision)
      values($1,$2,'example.com',1,$3,$4::jsonb,$4,'{}',$5,$6)`, [legacy.request.request_id, site, hash(legacyRaw), legacyRaw, hash('{}'), REVISION]), /seosmith_audits_s14_columns/)
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits')).rows[0].n, 0)
    await insert(f)
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits')).rows[0].n, 1)
    // UPDATE is forbidden.
    await assert.rejects(() => db.query("update public.seosmith_audits set fqdn='x' where delivery_id=$1", [f.id]), /audit_is_immutable/)
  } finally { await db.close() }
})

test('evidence is validated in the same transaction and errors map to evidence_invalid', async () => {
  const db = await boot()
  try {
    await as(db, 'service_role')
    const good = fixture()
    assert.ok(good.report.evidence_contract.evaluations.length > 0)
    assert.equal((await commit(db, good)).accepted, true)
    const bad = f => { const r = structuredClone(good.report); r.request.request_id = randomUUID(); f(r); const raw = JSON.stringify(r); return { id: r.request.request_id, raw, sha: hash(raw), summary: buildSummary(r), rev: REVISION } }
    const swap = bad(r => { [r.findings[0], r.findings[1]] = [r.findings[1], r.findings[0]] })
    await assert.rejects(() => commit(db, swap), e => /evidence_invalid/.test(e.message) && /invalid_evidence/.test(e.detail))
    await assert.rejects(() => commit(db, bad(r => { r.evidence_contract.evaluations[0].source_locator = '/findings/999' })), /evidence_invalid/)
    await assert.rejects(() => commit(db, bad(r => { r.evidence_contract.version = 2 })), /evidence_invalid/)
    await assert.rejects(() => commit(db, bad(r => { r.evidence_contract = [] })), /evidence_invalid/)
    // No evidence at all is allowed (the contract is optional).
    const plain = fixture({}, { evidence: false })
    assert.equal((await commit(db, plain)).accepted, true)
  } finally { await db.close() }
})

test('legacy RPCs and summaries still reject schema 4', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'anon')
    await assert.rejects(() => db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)', [TOKEN, f.id, f.sha, f.raw]), /unsupported_seosmith_schema/)
    await owned(db)
    await assert.rejects(() => db.query('select public.import_seosmith_audit($1,$2)', [site, f.raw]), /unsupported_seosmith_schema/)
    await as(db, 'postgres')
    await assert.rejects(() => db.query('select public.seosmith_summary($1::jsonb)', [f.raw]), /unsupported_seosmith_schema/)
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits')).rows[0].n, 0)
  } finally { await db.close() }
})

test('EXECUTE on the commit RPC is service_role only; the validator table is not reachable', async () => {
  const db = await boot()
  try {
    const f = fixture()
    for (const role of ['anon', 'authenticated']) {
      await as(db, role)
      await assert.rejects(() => commit(db, f), /permission denied/)
      await assert.rejects(() => db.query('select * from public.seosmith_s14_validators'), /permission denied/)
    }
    await as(db, 'postgres')
    const acl = (await db.query(`select has_function_privilege('anon','public.commit_seosmith_audit_v4(text,uuid,text,text,text,text)','execute') a,
      has_function_privilege('authenticated','public.commit_seosmith_audit_v4(text,uuid,text,text,text,text)','execute') u,
      has_function_privilege('service_role','public.commit_seosmith_audit_v4(text,uuid,text,text,text,text)','execute') s`)).rows[0]
    assert.deepEqual(acl, { a: false, u: false, s: true })
    const p = (await db.query("select prosecdef,proconfig from pg_proc where oid='public.commit_seosmith_audit_v4(text,uuid,text,text,text,text)'::regprocedure")).rows[0]
    assert.equal(p.prosecdef, true)
    assert.ok(p.proconfig.includes('statement_timeout=20s') && p.proconfig.includes('search_path=""'))
  } finally { await db.close() }
})

test('capability, history and detail expose schema 4 to the owner only', async () => {
  const db = await boot()
  try {
    const f = fixture()
    await as(db, 'service_role'); await commit(db, f)
    await as(db, 'anon')
    const caps = (await db.query('select public.seosmith_receiver_capabilities() as c')).rows[0].c
    assert.deepEqual(caps.schema_versions, [1, 2, 4])
    assert.deepEqual(caps.policy_wire_contracts, ['s14-wire-1'])
    assert.equal(caps.max_report_bytes, 4952756)
    assert.deepEqual(caps.evidence_contract_versions, [1])
    await owned(db)
    const history = (await db.query('select public.seosmith_audit_history($1) as h', [site])).rows[0].h
    assert.equal(history.items.length, 1)
    assert.deepEqual(history.items[0].summary, JSON.parse(f.summary))
    const d = (await db.query('select public.seosmith_audit_detail($1,$2) as d', [site, f.id])).rows[0].d
    assert.equal(d.summary_text, f.summary)
    assert.equal(d.summary_sha256, hash(f.summary))
    assert.equal(d.summary_bytes, Buffer.byteLength(f.summary))
    assert.equal(d.source_sha256, f.sha)
    assert.equal(d.source_bytes, Buffer.byteLength(f.raw))
    assert.equal(d.report_json, f.raw)
    assert.deepEqual(d.report, f.report)
    assert.deepEqual(d.summary, JSON.parse(f.summary))
    // A non-owner reads nothing.
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: other, is_anonymous: false })])
    await assert.rejects(() => db.query('select public.seosmith_audit_detail($1,$2)', [site, f.id]), /forbidden/)
    await assert.rejects(() => db.query('select public.seosmith_audit_history($1)', [site]), /forbidden/)
  } finally { await db.close() }
})

test('the precondition raises when a schema-4 row exists and passes beside a schema-2 row', async () => {
  const db = await boot(MIGRATION)
  try {
    const migration = await readFile(new URL(MIGRATION, migrations), 'utf8')
    // A schema-2 row from the legacy path is allowed.
    const v2 = JSON.parse(await readFile(new URL('fixtures/contracts/v2-complete.json', import.meta.url), 'utf8'))
    v2.request.website_id = site; v2.request.request_id = randomUUID()
    const raw = JSON.stringify(v2)
    await as(db, 'anon')
    await db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)', [TOKEN, v2.request.request_id, hash(raw), raw])
    await as(db, 'postgres')
    // Force a schema-4 row past the old trigger to represent a violated precondition.
    const f = fixture()
    await db.exec('set session_replication_role=replica')
    await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,$3,$4::jsonb)", [f.id, site, f.sha, f.raw])
    await db.exec('set session_replication_role=origin')
    await assert.rejects(() => db.exec(migration), /s14_schema4_rows_exist/)
    await db.exec('rollback')
    await db.query('delete from public.seosmith_audits where delivery_id=$1', [f.id])
    await db.exec(migration)
    assert.equal((await db.query('select count(*)::int n from public.seosmith_audits')).rows[0].n, 1)
    assert.deepEqual((await db.query('select revision,enabled from public.seosmith_s14_validators')).rows, [{ revision: REVISION, enabled: true }])
  } finally { await db.close() }
})

test('the seeded validator revision is exactly the receiver constant', async () => {
  const migration = await readFile(new URL(MIGRATION, migrations), 'utf8')
  assert.equal(REVISION, 's14-wire-1/full-population-1/evidence-v1')
  assert.equal(migration.split(`'${REVISION}'`).length - 1, 1)
  assert.match(migration, new RegExp(`values \\('${REVISION.replaceAll('/', '\\/')}',true\\)`))
  const candidates = [process.env.S14_H1_CHECKOUT && `${process.env.S14_H1_CHECKOUT}/crates/s14-receiver/src/admission.rs`,
    new URL('../../crates/s14-receiver/src/admission.rs', import.meta.url).pathname].filter(Boolean)
  const source = candidates.find(existsSync)
  assert.ok(source, 'receiver admission.rs not found; set S14_H1_CHECKOUT to the H1 checkout')
  assert.match(await readFile(source, 'utf8'), new RegExp(`VALIDATOR_REVISION[^=]*=\\s*"${REVISION.replaceAll('/', '\\/')}"`))
})
