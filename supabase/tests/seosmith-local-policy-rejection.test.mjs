import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// These are byte-for-byte copies of SEOsmith's frozen local-only schema 3
// fixtures. They must not become deliverable when receiver support is added.
const fixtures = {
  blocked: '3904a699c4f38a17c3fb613925f8196cb643f056f8ffbfbff7823ec6cb4ac2b8',
  complete: '90d500ca38451e3d9470a5973b501d0c4d86bde33364b99cbf92e1b21a596e71',
  intent: 'f55e73356125be13c11ae34a0314ae2caed52068adeeb8a888cb1ec2f016ce5c',
  omitted: '0841c04050ece34cbd3c708cac657627f6dab652958764ca028ff64e562cf4c2',
  partial: 'b2985402149b7b202fdd5e1326cb761b91e921e4293826b797790e49300fe57d',
  reordered: 'e08a333723f456331c1fd3763fcc0effc848aaa82652cb2ab677e3729b82b1ff',
  resolved: 'c714317afeaae89b6df1dac6339e1b5183f154b35b803041b341ea5748ccb21d',
}
const hash = value => createHash('sha256').update(value).digest('hex')
const owner = '00000000-0000-0000-0000-000000000001'
const token = 'x'.repeat(64)

test('all frozen local policy reports are rejected without a receipt or row on both paths', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    for (const name of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql','20261101054016_seosmith_expanded_evidence.sql','20261101060006_seosmith_policy_exclusions.sql','20261116210550_seosmith_versioned_receiver.sql','20261116221958_seosmith_summary_target_lookup.sql','20261116223631_h01_scanner_budget.sql','20261116224641_seosmith_summary_compact_input.sql','20261117120000_seosmith_ingest_budget.sql','20261121120000_seosmith_input_cap.sql','20261121130000_seosmith_rfc3339_intervals.sql']) {
      await db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'))
    }
    await db.query('insert into auth.users values($1)', [owner])
    for (const [name, expectedHash] of Object.entries(fixtures)) {
      const raw = await readFile(new URL(`fixtures/s14-local-1/v3-local-${name}.json`, import.meta.url), 'utf8')
      assert.equal(hash(raw), expectedHash, `${name} fixture bytes`)
      const report = JSON.parse(raw)
      assert.equal(report.schema_version, 3)
      const { website_id: site, request_id: id } = report.request
      await db.exec('reset role')
      await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com') on conflict do nothing", [site,owner])
      await db.query('delete from public.seosmith_bindings')
      await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)', [site,hash(token)])
      await db.exec('set role anon')
      await assert.rejects(() => db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)', [token,id,expectedHash,raw]), /unsupported_seosmith_schema/)
      await db.exec('reset role; set role authenticated')
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({sub:owner,is_anonymous:false})])
      await assert.rejects(() => db.query('select public.import_seosmith_audit($1,$2)', [site,raw]), /unsupported_seosmith_schema/)
      await db.exec('reset role')
      assert.equal((await db.query('select count(*)::int as count from public.seosmith_audits')).rows[0].count,0, `${name} stored no rows`)
    }
  } finally { await db.close() }
})
