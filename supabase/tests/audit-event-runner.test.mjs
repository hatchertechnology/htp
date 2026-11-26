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
    assert.deepEqual((await states(db)).map(j => j.state), ['held', 'processed', 'processed'], 'only the baseline-less first receipt is held; batch order holds nothing')
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
    // (Lock release under real contention is proven on PG17: scripts/audit-event-runner-pg17.)
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

const err = (db, sqlstate) => db.exec(`create or replace function public.boom() returns trigger language plpgsql as $$begin raise exception 'boom' using errcode='${sqlstate}'; end$$;
  drop trigger if exists boom on public.audit_events; create trigger boom before insert on public.audit_events for each row execute function public.boom()`)
const enable = (db) => db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
const status = (db) => db.query('select state,hold_reason,jobs::int jobs,max_attempts from public.audit_event_queue_status order by state,hold_reason').then(r => r.rows)

test('B-1: several receipts for one binding queued before a run are processed in receipt order, none held by batch order', async () => {
  const db = await setup()
  try {
    await enable(db)
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail'); await receipt(db, 3, '2026-11-03T00:00:00Z', 'fail')
    await receipt(db, 4, '2026-11-04T00:00:00Z', 'pass'); await receipt(db, 5, '2026-11-05T00:00:00Z', 'fail')
    await run(db)
    assert.deepEqual((await states(db)).map(j => [j.state, j.hold_reason]),
      [['held', 'history_unknown'], ['processed', null], ['processed', null], ['processed', null], ['processed', null]], 'only the first receipt (no baseline) is held')
    // B (pass->fail) emits, C (fail->fail) does not, E (pass->fail after a prior failure) is reopened.
    assert.deepEqual((await db.query('select kind,delivery_id,baseline_id from public.audit_events order by kind')).rows,
      [{ kind: 'new', delivery_id: uid(2), baseline_id: uid(1) }, { kind: 'reopened', delivery_id: uid(5), baseline_id: uid(4) }])
    assert.deepEqual(await status(db), [{ state: 'held', hold_reason: 'history_unknown', jobs: 1, max_attempts: 0 }, { state: 'processed', hold_reason: null, jobs: 4, max_attempts: 0 }])
  } finally { await db.close() }
})

test('B-1: a genuinely late or tied receipt is held late_or_tied, visibly, without events', async () => {
  const db = await setup()
  try {
    await enable(db)
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 3, '2026-11-03T00:00:00Z', 'fail')
    await run(db)
    assert.equal(await count(db, 'audit_events'), 1)
    // Receipt 2 (scan between 1 and 3) arrives after 3 was processed; receipt 4 ties receipt 5's scan.
    await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail')
    await receipt(db, 4, '2026-11-05T00:00:00Z', 'pass'); await receipt(db, 5, '2026-11-05T00:00:00Z', 'fail')
    await run(db)
    const by = Object.fromEntries((await states(db)).map(j => [j.delivery_id, [j.state, j.hold_reason]]))
    assert.deepEqual(by[uid(2)], ['held', 'late_or_tied'])
    assert.deepEqual(by[uid(4)], ['held', 'late_or_tied']); assert.deepEqual(by[uid(5)], ['held', 'late_or_tied'])
    assert.equal(await count(db, 'audit_events'), 1, 'late receipts emit nothing')
    const late = (await status(db)).find(r => r.hold_reason === 'late_or_tied')
    assert.equal(late.jobs, 3, 'the holds are countable in audit_event_queue_status')
    await db.exec('set role service_role'); await db.query('select * from public.audit_event_queue_status'); await db.exec('reset role')
    for (const role of ['anon', 'authenticated']) { await db.exec(`set role ${role}`); await assert.rejects(() => db.query('select * from public.audit_event_queue_status'), /permission denied/); await db.exec('reset role') }
  } finally { await db.close() }
})

test('M-1: transient errors leave the job pending with a bounded attempt count; deterministic errors hold at once', async () => {
  const db = await setup()
  try {
    await enable(db)
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail')
    await db.query("update public.audit_event_jobs set state='processed' where delivery_id=$1", [uid(1)])
    await err(db, '55P03') // lock_not_available
    for (let i = 1; i <= 4; i++) {
      await run(db)
      const j = (await states(db)).find(x => x.delivery_id === uid(2)); assert.equal(j.state, 'pending', `attempt ${i} stays retryable`)
      assert.equal((await db.query('select attempts,last_sqlstate from public.audit_event_job_attempts')).rows[0].attempts, i)
    }
    // R-2: the budget is time, not ticks: many quick ticks stay retryable, and the same job
    // is held only once the failure episode is older than 30 minutes.
    for (let i = 0; i < 20; i++) await run(db)
    assert.equal((await states(db)).find(x => x.delivery_id === uid(2)).state, 'pending', '24 ticks within minutes never exhaust the budget')
    await db.query("update public.audit_event_job_attempts set first_failed_at=now()-interval '29 minutes',last_at=now()-interval '1 minute'"); await run(db)
    assert.equal((await states(db)).find(x => x.delivery_id === uid(2)).state, 'pending', '29 minutes is still inside the window')
    await db.query("update public.audit_event_job_attempts set first_failed_at=now()-interval '31 minutes',last_at=now()-interval '1 minute'"); await run(db)
    assert.deepEqual((await states(db)).find(x => x.delivery_id === uid(2)), { delivery_id: uid(2), state: 'held', hold_reason: 'processor_unavailable' })
    assert.deepEqual(await status(db), [{ state: 'held', hold_reason: 'processor_unavailable', jobs: 1, max_attempts: 26 }, { state: 'processed', hold_reason: null, jobs: 1, max_attempts: 0 }])
    // A transient failure recovers: the retried job is processed once the fault clears.
    await db.query("update public.audit_event_jobs set state='pending',hold_reason=null where delivery_id=$1", [uid(2)])
    await db.query('delete from public.audit_event_job_attempts')
    await err(db, '40P01'); await run(db)
    assert.equal((await states(db)).find(x => x.delivery_id === uid(2)).state, 'pending')
    await db.exec('drop trigger boom on public.audit_events'); await run(db)
    assert.equal((await states(db)).find(x => x.delivery_id === uid(2)).state, 'processed'); assert.equal(await count(db, 'audit_events'), 1)
    // Deterministic poison classes hold on the first failure.
    for (const [k, code] of [[3, '22P02'], [4, '23514']]) {
      await receipt(db, k, `2026-11-0${k + 1}T00:00:00Z`, 'pass'); await receipt(db, k + 10, `2026-11-0${k + 1}T12:00:00Z`, 'fail')
      await db.query("update public.audit_event_jobs set state='processed' where delivery_id=$1", [uid(k)])
      await err(db, code); await run(db)
      const j = (await states(db)).find(x => x.delivery_id === uid(k + 10)); assert.deepEqual([j.state, j.hold_reason], ['held', 'processor_unavailable'], code)
      await db.exec('drop trigger boom on public.audit_events')
    }
  } finally { await db.close() }
})

test('M-1: a retryable failure stops the run so a binding is never processed out of order', async () => {
  const db = await setup()
  try {
    await enable(db)
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'pass'); await receipt(db, 3, '2026-11-03T00:00:00Z', 'fail')
    await db.query("update public.audit_event_jobs set state='processed' where delivery_id=$1", [uid(1)])
    await db.exec(`create function public.slow() returns trigger language plpgsql as $$begin raise exception 'x' using errcode='55P03'; end$$;
      create trigger boom before update on public.audit_event_jobs for each row when (new.state='processed' and new.delivery_id='${uid(2)}') execute function public.slow()`)
    await run(db)
    assert.deepEqual((await states(db)).map(j => j.state), ['processed', 'pending', 'pending'], 'job 3 was not processed ahead of job 2')
  } finally { await db.close() }
})

test('M-2: history cap is 500 receipts per binding; the 501st is held history_capped, visibly', async () => {
  for (const [total, expected] of [[500, 'processed'], [501, 'held']]) {
    const db = await setup()
    try {
      // total-1 earlier receipts (no queue, enqueue off), then one receipt that is enqueued.
      await db.query(`insert into public.seosmith_audits select gen_random_uuid(),$1,'example.com',1,'worker','{"schema_version":2}'::jsonb,
        '2025-01-01T00:00:00Z'::timestamptz + g*interval '1 hour','{"findings":[]}'::jsonb from generate_series(1,$2) g`, [site, total - 1])
      await db.exec(`insert into public.seosmith_lifecycle_indexed select delivery_id,'indexed_v1',false,'policy','key','engine','rules' from public.seosmith_audits;
        insert into public.seosmith_lifecycle_evaluations select delivery_id,'entity','rule','${JSON.stringify(evaluation('pass'))}'::jsonb from public.seosmith_audits`)
      await enable(db)
      await receipt(db, 1, '2026-11-01T00:00:00Z', 'fail')
      await run(db)
      const j = (await states(db))[0]
      if (expected === 'processed') { assert.equal(j.state, 'processed'); assert.equal(await count(db, 'audit_events'), 1) }
      else {
        assert.deepEqual([j.state, j.hold_reason], ['held', 'history_capped'])
        assert.equal(await count(db, 'audit_events'), 0)
        assert.deepEqual(await status(db), [{ state: 'held', hold_reason: 'history_capped', jobs: 1, max_attempts: 0 }])
      }
    } finally { await db.close() }
  }
})

test('R-2: a failure long after the previous one starts a new episode instead of holding at once', async () => {
  const db = await setup()
  try {
    await enable(db)
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail')
    await db.query("update public.audit_event_jobs set state='processed' where delivery_id=$1", [uid(1)])
    await err(db, '55P03'); await run(db)
    await db.query("update public.audit_event_job_attempts set first_failed_at=now()-interval '3 days',last_at=now()-interval '3 days'")
    await run(db)
    const a = (await db.query("select attempts,first_failed_at>now()-interval '1 minute' fresh from public.audit_event_job_attempts")).rows[0]
    assert.deepEqual([a.attempts, a.fresh], [1, true])
    assert.equal((await states(db)).find(x => x.delivery_id === uid(2)).state, 'pending')
  } finally { await db.close() }
})

const asOwner = async (db) => {
  await db.exec(`create or replace function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create or replace function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$`)
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, is_anonymous: false })])
}
const history = async (db) => { await db.exec('set role authenticated'); try { return (await db.query('select public.audit_event_history($1) h', [site])).rows[0].h } finally { await db.exec('reset role') } }

test('WP3: the stored-history reads report the real producer state with stable codes', async () => {
  const db = await setup()
  try {
    await asOwner(db)
    const code = async () => (await history(db)).availability
    assert.equal(await code(), 'producer_unavailable', 'gates off')
    const off = await history(db)
    assert.deepEqual([off.producer.processing_enabled, off.producer.last_success_at, off.producer.pending, off.producer.counts_capped], [false, null, 0, false])
    await db.exec('update public.audit_event_config set processing_enabled=true')
    assert.equal(await code(), 'producer_not_enqueuing')
    await db.exec('update public.audit_event_config set enqueue_enabled=true')
    assert.equal(await code(), 'producer_starting', 'enabled but never ran')
    await receipt(db, 1, '2026-11-01T00:00:00Z', 'pass'); await receipt(db, 2, '2026-11-02T00:00:00Z', 'fail'); await receipt(db, 3, '2026-11-03T00:00:00Z', 'pass')
    assert.equal((await history(db)).producer.pending, 3)
    await run(db)
    let h = await history(db)
    assert.equal(h.availability, 'producer_active')
    assert.deepEqual([h.producer.pending, h.producer.held, h.producer.last_outcome], [0, 1, 'success'])
    assert.deepEqual(h.producer.held_by_reason, { history_unknown: 1 })
    assert.ok(h.producer.last_success_at)
    await db.exec("update public.audit_event_run_state set last_run_at=now()-interval '6 minutes'")
    assert.equal(await code(), 'producer_stale')
    // A retrying run is degraded and does not advance last_success_at.
    await receipt(db, 4, '2026-11-04T00:00:00Z', 'fail'); await err(db, '55P03')
    const before = (await history(db)).producer.last_success_at
    await run(db)
    h = await history(db)
    assert.deepEqual([h.availability, h.producer.last_outcome, h.producer.pending, h.producer.last_success_at], ['producer_degraded', 'retry', 1, before])
    await db.exec('drop trigger boom on public.audit_events'); await run(db)
    assert.equal(await code(), 'producer_active')
    // Disabling processing is reported at once; the runner no-op does not refresh liveness.
    await db.exec('update public.audit_event_config set processing_enabled=false')
    const ran = (await db.query('select last_run_at from public.audit_event_run_state')).rows[0].last_run_at
    await run(db)
    assert.deepEqual((await db.query('select last_run_at from public.audit_event_run_state')).rows[0].last_run_at, ran)
    assert.equal(await code(), 'producer_unavailable')
    // Counts are capped at 1000 and say so.
    await db.exec(`update public.audit_event_config set processing_enabled=true;
      insert into public.seosmith_audits select gen_random_uuid(),website_id,fqdn,generation,ingestion_source,summary,scan_at+(g||' minutes')::interval,report
        from public.seosmith_audits, generate_series(1,1001) g where delivery_id='${uid(1)}'`)
    h = await history(db)
    assert.deepEqual([h.producer.counts_capped, h.producer.pending + h.producer.held], [true, 1001])
  } finally { await db.close() }
})

test('WP3: operational history reports the operations gate; producer helpers are not client-callable', async () => {
  const db = await setup()
  try {
    await asOwner(db)
    const read = async () => { await db.exec('set role authenticated'); try { return (await db.query('select public.audit_operational_history($1) h', [site])).rows[0].h } finally { await db.exec('reset role') } }
    let h = await read(); assert.deepEqual([h.availability, h.producer], ['producer_unavailable', { operations_enabled: false }])
    await db.exec('update public.audit_event_config set operations_enabled=true')
    h = await read(); assert.equal(h.availability, 'producer_active')
    await db.exec('set role authenticated')
    await assert.rejects(() => db.query('select public.audit_event_producer_state($1,$2)', [site, 'example.com']), /permission denied/)
    await assert.rejects(() => db.query('select * from public.audit_event_run_state'), /permission denied/)
    await db.exec('reset role')
  } finally { await db.close() }
})
