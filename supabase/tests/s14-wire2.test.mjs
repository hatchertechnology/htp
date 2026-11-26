// WP8c-2: migration 20261215000000_s14_wire2.sql (database half of s14-wire-2).
// The limits are exercised directly on the commit RPC and the insert trigger, never through
// the receiver (design wave1-wp8a.md section 5, `commit` stage). Postgres is PGlite (PG17), as
// in the other supabase/tests; every test boots the whole migration chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { buildSummary } from '../../scripts/s14-schema4-native/gen.mjs'

const MIGRATION = '20261215000000_s14_wire2.sql'
const ROLLBACK = '../rollbacks/20261215000000_s14_wire2_disable.sql'
const V1 = 's14-wire-1/full-population-1/evidence-v1'
const V2 = 's14-wire-2/full-population-1/evidence-v1/families-v1'
const hash = v => createHash('sha256').update(v).digest('hex')
const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002'
const site = '00000000-0000-0000-0000-000000000003', site2 = '00000000-0000-0000-0000-000000000004'
const TOKEN = 'x'.repeat(64)
const migrations = new URL('../migrations/', import.meta.url)
const files = (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()
const read = path => readFile(new URL(path, import.meta.url), 'utf8')
const contracts = JSON.parse(await read('./fixtures/contracts/v2-complete.json'))
const RULES = contracts.evidence_contract.coverage.map(c => c.rule)
const FOUR = ['deadend', 'little_content', 'missing_language', 'missing_description']

// The whole chain up to (not including) migration 15 when `withMigration` is false.
async function boot({ withMigration = true } = {}) {
  const db = new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    alter default privileges grant execute on functions to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`)
  for (const f of files.filter(f => withMigration || f !== MIGRATION)) await db.exec(await read(`../migrations/${f}`))
  await db.query('insert into auth.users values($1),($2)', [owner, other])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com'),($3,$2,'other.example')", [site, owner, site2])
  await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2),($3,$4)', [site, hash(TOKEN), site2, hash('y'.repeat(64))])
  return db
}
const as = (db, role) => db.exec(`reset role;set role ${role}`)
const signedIn = async (db, sub = owner, anon = false) => {
  await db.exec('reset role;set role authenticated')
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub, is_anonymous: anon })])
}
const enableV2 = db => db.exec("reset role;update public.seosmith_s14_validators set enabled=true where revision like 's14-wire-2/%'")
const caps = async db => (await db.query('select public.seosmith_receiver_capabilities() c')).rows[0].c

// A SQL-valid schema-4 report (the database binds bytes and checks S01, not admission).
// `obs` pages carry an observation; `fails` is a list of [rule, pageIndex] failing evaluations.
function build({ id = randomUUID(), websiteId = site, pages = 3, obs = pages, fails = null, wire = 1, families } = {}) {
  fails ??= FOUR.flatMap(rule => Array.from({ length: obs }, (_, i) => [rule, i]))
  const url = i => `https://example.com/p/${i}`
  const entity = u => 'sha256:' + hash('seosmith-entity-v1\npage\n' + u)
  const ps = Array.from({ length: pages }, (_, i) => ({ ...structuredClone(contracts.pages[0]), url: url(i), title: `Page ${i}`, links: [] }))
  const findings = [], evaluations = []
  const observations = Array.from({ length: obs }, (_, i) => ({ entity_id: entity(url(i)), source_locator: `/pages/${i}`, state: 'available', unknown_reason: null }))
  for (const [rule, i] of fails) {
    const n = findings.length, key = hash(`${rule}\n${url(i)}`)
    findings.push({ key, rule, severity: 'warning', url: url(i), evidence: 'synthetic', evidence_items: ['synthetic'], details: {} })
    evaluations.push({ entity_id: entity(url(i)), rule, rule_version: contracts.ruleset_version, validator_version: 's01-1',
      eligibility: 'eligible', attempt: 'completed', outcome: 'fail', unknown_reason: null, source_locator: `/findings/${n}`,
      actual: { state: 'source', source_locator: `/findings/${n}/evidence_items` },
      expected: { state: 'unavailable', reason: 'legacy_expectation_not_recorded' }, confidence: 'high', finding_key: key })
  }
  const coverage = RULES.map(rule => {
    const k = fails.filter(([r]) => r === rule).length, unknown_reasons = {}
    if (obs - k > 0) unknown_reasons.legacy_not_instrumented = obs - k
    if (pages - obs > 0) unknown_reasons.contract_limit = pages - obs
    return { rule, entities: pages, eligible: k, ineligible: 0, eligibility_unknown: pages - k, attempted: k, not_attempted: 0,
      attempt_unknown: pages - k, passed: 0, failed: k, not_applicable: 0, unknown: pages - k, unknown_reasons }
  })
  const request = { ...contracts.request, request_id: id, website_id: websiteId, binding_generation: 1 }
  const report = {
    schema_version: 4, engine_version: contracts.engine_version, ruleset_version: contracts.ruleset_version, request,
    started_at: contracts.started_at, finished_at: contracts.finished_at, outcome: 'completed', stop_reason: contracts.stop_reason,
    coverage_complete: true, pages: ps, findings,
    policy_guidance: { synthetic: true, version: wire === 2 ? 's14-wire-2' : 's14-wire-1' },
    evidence_contract: { version: 1, policy: contracts.evidence_contract.policy, comparison_key: contracts.evidence_contract.comparison_key,
      observed_at: { started_at: contracts.started_at, finished_at: contracts.finished_at }, observations, evaluations, coverage,
      truncated: pages > obs, omitted_observations: pages - obs, evaluation_coverage_complete: false },
  }
  if (families !== undefined) report.evidence_families = families
  const raw = JSON.stringify(report)
  const summary = JSON.stringify({ ...JSON.parse(buildSummary(report)), wire_contract_version: wire === 2 ? 's14-wire-2' : 's14-wire-1' })
  return { id, report, raw, sha: hash(raw), summary, rev: wire === 2 ? V2 : V1 }
}
const FAMILIES = { version: 1, semantics: 's14-families-1', max_bytes: 786432, budget_state: 'within_budget', families: {} }
const v2 = (opts = {}) => build({ wire: 2, families: FAMILIES, ...opts })
const commit = (db, f, rev = f.rev) => db.query('select public.commit_seosmith_audit_v4($1,$2,$3,$4,$5,$6) as r', [TOKEN, f.id, f.sha, f.raw, f.summary, rev]).then(r => r.rows[0].r)
const committed = async (db, f) => { await as(db, 'service_role'); return commit(db, f) }
// The insert trigger called directly (no RPC around it), as the privileged owner.
const insertRow = (db, f, rev = f.rev) => db.query(`insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source,summary_text,summary_sha256,validator_revision)
  values($1,$2,'example.com',1,$3,$4::jsonb,$5,'worker',$6,$7,$8)`, [f.id, site, f.sha, f.raw, f.raw, f.summary, hash(f.summary), rev])
const rejects = (promise, code, re) => assert.rejects(() => promise, e => e.code === code && re.test(`${e.message} ${e.detail ?? ''}`), `expected ${code} ${re}`)

test('migration 15 applies on the full chain, installs the v2 revision disabled and keeps v1 enabled', async () => {
  const db = await boot()
  try {
    const rows = (await db.query('select revision,enabled from public.seosmith_s14_validators order by revision')).rows
    assert.deepEqual(rows, [{ revision: V1, enabled: true }, { revision: V2, enabled: false }])
    assert.match(V2, /^[A-Za-z0-9._/-]{1,128}$/)
  } finally { await db.close() }
})

test('the precondition guard refuses a database that already holds a wire-2 row', async () => {
  const db = await boot({ withMigration: false })
  try {
    await db.exec("insert into public.seosmith_s14_validators(revision,enabled) values('s14-wire-2/legacy/x',true)")
    const f = build()
    await db.exec('set session_replication_role=replica') // plant the row without the (not yet wire-2 aware) trigger
    await db.query(`insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source,summary_text,summary_sha256,validator_revision)
      values($1,$2,'example.com',1,$3,$4::jsonb,$5,'worker',$6,$7,'s14-wire-2/legacy/x')`, [f.id, site, f.sha, f.raw, f.raw, f.summary, hash(f.summary)])
    await db.exec('set session_replication_role=origin')
    const sql = await read(`../migrations/${MIGRATION}`)
    await assert.rejects(() => db.exec(sql), /s14_wire2_rows_exist/)
  } finally { await db.close() }
})

test('v1 limits are unchanged: 128 observations and 512 evaluations pass, 129 and 513 are rejected', async () => {
  const db = await boot()
  try {
    const exact = build({ pages: 128, obs: 128 }) // 128 x 4 = 512 evaluations
    assert.equal(exact.report.evidence_contract.evaluations.length, 512)
    assert.equal((await committed(db, exact)).accepted, true)
    const obs129 = build({ pages: 129, obs: 129, fails: FOUR.flatMap(r => Array.from({ length: 100 }, (_, i) => [r, i])) })
    await rejects(commit(db, obs129), '22023', /evidence_invalid.*evidence_contract_limit/s)
    const evals513 = build({ pages: 128, obs: 128, fails: [...FOUR.flatMap(r => Array.from({ length: 128 }, (_, i) => [r, i])), ['missing_h1', 0]] })
    assert.equal(evals513.report.evidence_contract.evaluations.length, 513)
    await rejects(commit(db, evals513), '22023', /evidence_invalid.*evidence_contract_limit/s)
  } finally { await db.close() }
})

test('the evidence validator keeps its 1-argument form at 128/512 and gains a limit-taking overload', async () => {
  const db = await boot()
  try {
    const compact = build({ pages: 129, obs: 129, fails: FOUR.flatMap(r => Array.from({ length: 100 }, (_, i) => [r, i])) }).report
    const small = { ...compact, schema_version: 2 }
    await rejects(db.query('select public.seosmith_validate_evidence($1::jsonb)', [small]), '22023', /evidence_contract_limit/)
    await rejects(db.query('select public.seosmith_validate_evidence($1::jsonb,128,512)', [small]), '22023', /evidence_contract_limit/)
    await db.query('select public.seosmith_validate_evidence($1::jsonb,1024,1024)', [small])
    // The 1-argument form keeps its existing ACL (service_role may hold the provider's default grant); the new overload has none.
    for (const [sig, roles] of [['seosmith_validate_evidence(jsonb)', ['anon', 'authenticated']], ['seosmith_validate_evidence(jsonb,integer,integer)', ['anon', 'authenticated', 'service_role']]]) {
      for (const role of roles) {
        assert.equal((await db.query('select has_function_privilege($1,$2::regprocedure,\'execute\') ok', [role, `public.${sig}`])).rows[0].ok, false, `${role} ${sig}`)
      }
    }
  } finally { await db.close() }
})

test('a v2 delivery is validator_disabled while the revision is disabled and accepted once enabled', async () => {
  const db = await boot()
  try {
    const f = v2()
    await as(db, 'service_role')
    await rejects(commit(db, f), '55000', /validator_disabled/)
    await enableV2(db)
    await as(db, 'service_role')
    assert.deepEqual(await commit(db, f), { delivery_id: f.id, sha256: f.sha, accepted: true })
    await as(db, 'postgres')
    const row = (await db.query('select validator_revision,report from public.seosmith_audits where delivery_id=$1', [f.id])).rows[0]
    assert.equal(row.validator_revision, V2)
    assert.deepEqual(row.report.evidence_families, FAMILIES)
  } finally { await db.close() }
})

test('v2 limits are 1024 observations and 1024 evaluations, called on the RPC and on the trigger', async () => {
  const db = await boot()
  try {
    await enableV2(db)
    const top = n => FOUR.flatMap(r => Array.from({ length: n / 4 }, (_, i) => [r, i]))
    // 1,024 observations and 1,024 evaluations (4 x 256) through the commit RPC.
    const exact = v2({ pages: 1024, obs: 1024, fails: top(1024) })
    assert.equal(exact.report.evidence_contract.observations.length, 1024)
    assert.equal(exact.report.evidence_contract.evaluations.length, 1024)
    await as(db, 'service_role')
    assert.equal((await commit(db, exact)).accepted, true)
    // 1,025 observations (rejected on the trigger directly, as the table owner).
    await as(db, 'postgres')
    await rejects(insertRow(db, v2({ pages: 1025, obs: 1025, fails: top(512) })), '22023', /evidence_invalid.*evidence_contract_limit/s)
    // 1,025 evaluations.
    const evals = v2({ pages: 1024, obs: 1024, fails: [...top(1024), ['missing_h1', 0]] })
    assert.equal(evals.report.evidence_contract.evaluations.length, 1025)
    await rejects(insertRow(db, evals), '22023', /evidence_invalid.*evidence_contract_limit/s)
    // The same 1,025 observations are accepted by neither revision; the 129th is rejected under v1.
    await rejects(insertRow(db, build({ pages: 129, obs: 129, fails: top(400) }), V1), '22023', /evidence_contract_limit/)
  } finally { await db.close() }
})

test('evidence_families: forbidden under v1 (object or null), required object under v2, version 1, compact bytes <= 786,432', async () => {
  const db = await boot()
  try {
    await enableV2(db)
    const bad = async (f, re) => rejects(insertRow(db, f), '22023', re)
    await bad(build({ families: FAMILIES }), /evidence_families/)
    await bad(build({ families: null }), /evidence_families/)
    await bad(build({ wire: 2 }), /evidence_families/) // v2 without the member
    await bad(build({ wire: 2, families: null }), /evidence_families/)
    await bad(build({ wire: 2, families: [] }), /evidence_families/)
    await bad(build({ wire: 2, families: { ...FAMILIES, version: 2 } }), /evidence_families/)
    await bad(build({ wire: 2, families: { ...FAMILIES, version: '1' } }), /evidence_families/)
    const sized = n => { // compact JSON length of the member is exactly n bytes
      const base = JSON.stringify({ ...FAMILIES, pad: '' }).length
      return { ...FAMILIES, pad: 'x'.repeat(n - base) }
    }
    assert.equal(JSON.stringify(sized(786432)).length, 786432)
    await bad(build({ wire: 2, families: sized(786433) }), /evidence_families/)
    // jsonb::text adds a space after ':' and ',', so a naive length(x::text) check would reject this.
    const edge = build({ wire: 2, families: sized(786432), id: randomUUID() })
    assert.ok((await db.query('select length($1::jsonb::text) n', [JSON.stringify(sized(786432))])).rows[0].n > 786432)
    await insertRow(db, edge) // accepted: counts compact bytes
  } finally { await db.close() }
})

test('a committed v2 delivery replays its receipt after the revision is disabled; changed bytes still conflict', async () => {
  const db = await boot()
  try {
    await enableV2(db)
    const f = v2()
    const receipt = await committed(db, f)
    await as(db, 'postgres')
    await db.exec(await read(ROLLBACK))
    await as(db, 'service_role')
    assert.deepEqual(await commit(db, f), receipt)
    const changed = f.raw + ' '
    await rejects(commit(db, { ...f, raw: changed, sha: hash(changed) }), '23505', /delivery_conflict/)
    await rejects(commit(db, v2()), '55000', /validator_disabled/) // a new v2 delivery is held
    assert.equal((await commit(db, build())).accepted, true) // v1 is unaffected by the rollback
  } finally { await db.close() }
})

test('capabilities: stable, v1 keys unchanged, wire-2 appears only while the validator is enabled, rollback restores them', async () => {
  const db = await boot()
  try {
    const volatility = () => db.query("select provolatile v from pg_proc where oid='public.seosmith_receiver_capabilities()'::regprocedure").then(r => r.rows[0].v)
    assert.equal(await volatility(), 's')
    const wire1 = { max_evidence_observations: 128, max_evaluations: 512, max_manifest_bytes: 262144 }
    const before = await caps(db)
    assert.deepEqual(before.policy_wire_contracts, ['s14-wire-1'])
    assert.deepEqual(before.wire_limits, { 's14-wire-1': wire1 })
    assert.equal(before.max_evidence_observations, 128)
    assert.equal(before.max_evaluations, 512)
    await enableV2(db)
    const after = await caps(db)
    assert.deepEqual(after.policy_wire_contracts, ['s14-wire-1', 's14-wire-2'])
    assert.deepEqual(after.wire_limits, { 's14-wire-1': wire1, 's14-wire-2': { max_evidence_observations: 1024, max_evaluations: 1024,
      max_manifest_bytes: 16384, manifest_form: 'digest', evidence_families_versions: [1], max_evidence_families_bytes: 786432 } })
    // Everything else, including the v1 numbers older clients read, is identical.
    const { policy_wire_contracts: _a, wire_limits: _b, ...rest } = after
    const { policy_wire_contracts: _c, wire_limits: _d, ...restBefore } = before
    assert.deepEqual(rest, restBefore)
    for (const role of ['anon', 'authenticated']) { await as(db, role); assert.deepEqual(await caps(db), after) }
    await as(db, 'postgres')
    await db.exec(await read(ROLLBACK))
    assert.deepEqual(await caps(db), before)
    assert.equal(await volatility(), 's')
  } finally { await db.close() }
})

test('seosmith_audit_evidence_families: held until granted, owner 200, nonowner and anon forbidden', async () => {
  const db = await boot()
  try {
    await enableV2(db)
    const f2 = v2(), f1 = build()
    await committed(db, f2); await commit(db, f1)
    const call = (website, delivery) => db.query('select public.seosmith_audit_evidence_families($1,$2) r', [website, delivery]).then(r => r.rows[0].r)
    // Held: not executable by any API role until the R6 grant.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await db.query("select has_function_privilege($1,'public.seosmith_audit_evidence_families(uuid,uuid)','execute') ok", [role])).rows[0].ok, false, role)
    }
    await signedIn(db)
    await rejects(call(site, f2.id), '42501', /permission denied/)
    await as(db, 'postgres')
    await db.exec('grant execute on function public.seosmith_audit_evidence_families(uuid,uuid) to authenticated') // grant-families.sql
    await signedIn(db)
    assert.deepEqual(await call(site, f2.id), { delivery_id: f2.id, wire_contract_version: 's14-wire-2', evidence_families: FAMILIES, reason: null })
    assert.deepEqual(await call(site, f1.id), { delivery_id: f1.id, wire_contract_version: 's14-wire-1', evidence_families: null, reason: 'not_collected' })
    assert.equal(await call(site, randomUUID()), null)
    assert.equal(await call(site2, f2.id), null) // another website's id never reveals this delivery
    await signedIn(db, other)
    await rejects(call(site, f2.id), '42501', /forbidden/)
    await signedIn(db, owner, true)
    await rejects(call(site, f2.id), '42501', /forbidden/)
    await as(db, 'anon')
    await rejects(call(site, f2.id), '42501', /permission denied/)
    await as(db, 'postgres') // even if it were granted to anon, auth.uid() is null: forbidden
    await db.exec('grant execute on function public.seosmith_audit_evidence_families(uuid,uuid) to anon')
    await as(db, 'anon')
    await rejects(call(site, f2.id), '42501', /forbidden/)
  } finally { await db.close() }
})

test('the rollback file only disables wire-2 and is idempotent', async () => {
  const db = await boot()
  try {
    await enableV2(db)
    const rollback = await read(ROLLBACK)
    await db.exec(rollback); await db.exec(rollback)
    const rows = (await db.query('select revision,enabled from public.seosmith_s14_validators order by revision')).rows
    assert.deepEqual(rows, [{ revision: V1, enabled: true }, { revision: V2, enabled: false }])
  } finally { await db.close() }
})
