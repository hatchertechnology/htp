import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const rd = (p) => readFile(new URL(p, import.meta.url), 'utf8')
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const site = uid(21), owner = uid(22), job1 = uid(31)

async function setup() {
  const db = new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$; create function auth.uid() returns uuid language sql as $$select null::uuid$$;
   create table public.websites(id uuid primary key,owner_id uuid,fqdn text);
   create table public.seosmith_audits(delivery_id uuid primary key,website_id uuid,fqdn text,generation bigint,ingestion_source text,summary jsonb,scan_at timestamptz,report jsonb);
   create table public.google_report_jobs(id uuid primary key,website_id uuid,fqdn text);
   create table public.bing_report_jobs(id uuid primary key,website_id uuid,fqdn text);
   create table public.website_repositories(id uuid primary key,website_id uuid,fqdn text);
   create table public.seosmith_lifecycle_indexed(delivery_id uuid primary key,state text,evidence_truncated boolean,policy_digest text,comparison_key text,engine_version text,ruleset_version text);
   create table public.seosmith_lifecycle_evaluations(delivery_id uuid,entity_id text,rule text,evaluation jsonb,primary key(delivery_id,entity_id,rule));
   grant usage on schema public,auth to authenticated,anon,service_role;`)
  await db.exec(await rd('../migrations/20261203000000_audit_event_queue.sql'))
  await db.exec(await rd('../migrations/20261214000000_audit_event_runner.sql'))
  await db.query("insert into public.websites values($1,$2,'example.com')", [site, owner])
  return db
}
const evaluation = (outcome) => ({ eligibility: 'eligible', attempt: 'completed', outcome, rule_version: '1', validator_version: '1', source_locator: '/evaluations/0', finding_key: outcome === 'fail' ? 'f' : null })
// Adds a worker receipt with one (entity, rule) evaluation, indexed unless truncated.
async function receipt(db, n, time, outcome, { truncated = false } = {}) {
  await db.query('insert into public.seosmith_audits values($1,$2,$3,1,$4,$5,$6,$7)',
    [uid(n), site, 'example.com', 'worker', { schema_version: 2 }, time, { findings: outcome === 'fail' ? [{ key: 'f', severity: 'warning' }] : [] }])
  await db.query("insert into public.seosmith_lifecycle_indexed values($1,'indexed_v1',$2,'policy','key','engine','rules')", [uid(n), truncated])
  await db.query('insert into public.seosmith_lifecycle_evaluations values($1,$2,$3,$4)', [uid(n), 'entity', 'rule', evaluation(outcome)])
}
const states = (db) => db.query('select delivery_id,state,hold_reason from public.audit_event_jobs order by created_at,delivery_id').then(r => r.rows)
const count = (db, t) => db.query(`select count(*)::int n from public.${t}`).then(r => r.rows[0].n)
const run = (db, n = 50) => db.query('call public.audit_event_run($1)', [n])

test('runner is service-only, bounded and inert while processing is disabled', async () => {
  const db = await setup()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true')
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail')
    assert.equal(await count(db, 'audit_event_jobs'), 2)
    await run(db) // processing_enabled=false: nothing is claimed or changed
    assert.deepEqual((await states(db)).map(j => j.state), ['pending', 'pending'])
    assert.equal(await count(db, 'audit_events'), 0)
    await assert.rejects(() => run(db, 0), /invalid_max/)
    await assert.rejects(() => run(db, 501), /invalid_max/)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(() => run(db), /permission denied/)
      await db.exec('reset role')
    }
    await db.exec('set role service_role'); await run(db); await db.exec('reset role')
  } finally { await db.close() }
})

test('unchanged scan emits 0 events; pass to fail emits one new event, deduplicated on rerun', async () => {
  const db = await setup()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass')
    await run(db) // lone first receipt has no baseline: held, never an event
    assert.equal((await states(db))[0].hold_reason, 'history_unknown')
    await receipt(db, 2, '2026-11-02T00:00:00Z', 'pass')
    await run(db)
    assert.equal((await states(db)).find(j => j.delivery_id === uid(2)).state, 'processed')
    assert.equal(await count(db, 'audit_events'), 0, 'unchanged scan')
    await receipt(db, 3, '2026-11-03T00:00:00Z', 'fail')
    await run(db)
    assert.deepEqual((await db.query('select kind,rule,severity,delivery_id,baseline_id from public.audit_events')).rows,
      [{ kind: 'new', rule: 'rule', severity: 'warning', delivery_id: uid(3), baseline_id: uid(2) }])
    // Reprocess the same receipt: re-enqueue it as pending; the unique event key keeps one row.
    await db.query("update public.audit_event_jobs set state='pending' where delivery_id=$1", [uid(3)])
    await run(db)
    assert.equal(await count(db, 'audit_events'), 1, 'rerun deduplicates')
    assert.equal((await states(db)).find(j => j.delivery_id === uid(3)).state, 'processed')
    await run(db); assert.equal(await count(db, 'audit_events'), 1, 'drained queue is a no-op')
  } finally { await db.close() }
})

test('a truncated receipt is held, not processed', async () => {
  const db = await setup()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass')
    await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail', { truncated: true })
    await run(db)
    const j = (await states(db)).find(x => x.delivery_id === uid(2))
    assert.deepEqual([j.state, j.hold_reason], ['held', 'index_pending'])
    assert.equal(await count(db, 'audit_events'), 0)
  } finally { await db.close() }
})

test('concurrent runners converge: an active lease excludes the binding, an expired one is reclaimed', async () => {
  const db = await setup()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'pass'); await receipt(db, 3, '2026-11-03T00:00:00Z', 'fail')
    // Another runner holds a live lease on this binding/generation.
    const other = (await db.query('select public.audit_event_claim() c')).rows[0].c
    assert.equal(other.delivery_id, uid(1))
    await run(db)
    assert.deepEqual((await states(db)).map(j => j.state), ['leased', 'pending', 'pending'], 'second runner claims nothing')
    // The other runner dies; its lease expires and this runner converges.
    await db.query("update public.audit_event_jobs set leased_until=now()-interval '1 minute' where delivery_id=$1", [uid(1)])
    await run(db)
    assert.deepEqual((await states(db)).map(j => j.state), ['held', 'held', 'processed'], 'older receipts are held once a later one exists')
    assert.equal(await count(db, 'audit_events'), 1)
    await run(db); assert.equal(await count(db, 'audit_events'), 1)
    // p_max bounds one run.
    await db.query("update public.audit_event_jobs set state='pending',hold_reason=null where delivery_id in ($1,$2)", [uid(2), uid(3)])
    await run(db, 1)
    assert.equal((await states(db)).filter(j => j.state === 'pending').length, 1)
  } finally { await db.close() }
})

test('a poisoned job is held as processor_unavailable and does not block the queue', async () => {
  const db = await setup()
  try {
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail')
    await db.exec(`create function public.boom() returns trigger language plpgsql as $$begin raise exception 'boom'; end$$;
      create trigger boom before insert on public.audit_events for each row execute function public.boom()`)
    await db.query("update public.audit_event_jobs set state='processed' where delivery_id=$1", [uid(1)])
    await run(db)
    const j = (await states(db)).find(x => x.delivery_id === uid(2))
    assert.deepEqual([j.state, j.hold_reason], ['held', 'processor_unavailable'])
    assert.equal(await count(db, 'audit_events'), 0, 'partial work rolled back')
    // The lock was released with the failed block: a receipt insert is not blocked.
    await db.query("insert into public.seosmith_audits values($1,$2,'example.com',1,'import',$3,now(),null)", [uid(9), site, { schema_version: 2 }])
  } finally { await db.close() }
})

test('a provider failure opens an episode and a success closes it', async () => {
  const db = await setup()
  try {
    await db.query('insert into public.google_report_jobs values($1,$2,$3)', [job1, site, 'example.com'])
    await db.exec('update public.audit_event_config set operations_enabled=true')
    const op = (o, e = null) => db.query('select public.audit_operational_completion($1,$2,$3,$4,$5,$6) id', [site, 'example.com', 'google', job1, o, e]).then(r => r.rows[0].id)
    const episode = await op('failed', 'other'); assert.ok(episode)
    assert.equal((await db.query('select count(*)::int n from public.audit_operational_episodes where recovered_at is null')).rows[0].n, 1)
    assert.equal(await op('recovered'), episode)
    assert.equal((await db.query('select count(*)::int n from public.audit_operational_episodes where recovered_at is null')).rows[0].n, 0)
  } finally { await db.close() }
})

test('schedule script then unschedule script leave cron.job as it was; disable rollback closes the gates', async () => {
  const db = await setup()
  try {
    await db.exec(`create schema cron; create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text);
      create function cron.schedule(n text,s text,c text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values(n,s,c) returning jobid$$;
      create function cron.unschedule(id bigint) returns boolean language sql as $$delete from cron.job where jobid=id returning true$$;
      insert into cron.job(jobname,schedule,command) values('htp-google-sync','* * * * *','x'),('htp-bing-sync','* * * * *','y')`)
    const before = (await db.query('select jobname,schedule,command from cron.job order by jobname')).rows
    // pg_cron itself is absent from PGlite; the stub schema stands in for the extension.
    const schedule = (await rd('../cron/audit-events.sql')).replace(/^create extension.*$/m, '')
    await db.exec(schedule); await db.exec(schedule) // idempotent
    const jobs = (await db.query("select schedule,command from cron.job where jobname='htp-audit-events'")).rows
    assert.deepEqual(jobs, [{ schedule: '* * * * *', command: 'call public.audit_event_run(50);' }])
    const unschedule = await rd('../rollbacks/20261214000000_audit_event_runner_unschedule.sql')
    await db.exec(unschedule); await db.exec(unschedule) // asserts 0 rows remain; re-runnable
    assert.deepEqual((await db.query('select jobname,schedule,command from cron.job order by jobname')).rows, before)
    await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true,operations_enabled=true')
    await db.exec(await rd('../rollbacks/20261203000000_audit_notifications_disable.sql'))
    assert.deepEqual((await db.query('select enqueue_enabled,processing_enabled,operations_enabled from public.audit_event_config')).rows[0], { enqueue_enabled: false, processing_enabled: false, operations_enabled: false })
  } finally { await db.close() }
})
