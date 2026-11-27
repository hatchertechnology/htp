# Wire-2 local E2E work in progress

These tools use only a dedicated local test stack. They are not a deployment or R6 runner.

* `generate_fixture.py OUT [resources]` writes a network-free SEOsmith `FixtureTransport` map (57 numbered pages plus a home-page alias, up to 400 synthetic resources). Run the producer with `local-cli-fixtures,local-e2e` and `SEOSMITH_LOCAL_FIXTURES` pointing to the output.
* `seed.sql` creates the two local websites and bindings and enables the wire-2 validator after migrations. Create the test owner in local Auth first, then supply psql variables `owner_id`, `real_token_sha256`, and `fixture_token_sha256`.
* `crawl.sh URL RESOURCES OUT` submits to a prestarted local SEOsmith and checks downloaded bytes, admission summary and local DB receipt. It only accepts the fixture URL or the approved site and the three candidate bounds. Set `SEOSMITH_API_TOKEN`, `WEBSITE_ID`, `ADMIT`, `DB_CONTAINER=supabase_db_w1c8e`, and optionally `SEO_URL` (loopback only). The database and the producer must be dedicated test instances.
* `probe.py LOOPBACK_ENDPOINT REPORT` sends a fresh delivery for an old-receiver or disabled-validator probe. Set `HTP_INGEST_TOKEN` to the dedicated local test binding token. Verify the response and database row count separately.
* `measure.py REPORT` emits measured sizes, families, S01 counts, S05 omissions, the S14 omission table and gate results. The result is specific to that report, not an R6 bound recommendation.
* `measure_report_capture.rs` measures per-page capture time using the HTML pages in a retained acceptance report; copy into the producer scratch checkout and build as an example with `local-e2e,local-cli-fixtures`. It permits only the approved site and waits one second between requests.
* `v1_manifest.rs` is an SEOsmith scratch example using the producer's unvalidated list-form builder to measure the v1 manifest even if it exceeds the wire-1 cap. Copy it into a detached scratch checkout's `examples` and build with `--features policy-wire-prototype`.

This is not yet a complete automated harness: stack lifecycle, fixture and live crawl orchestration, commit/finalize/capture timing, old-receiver rejection and rollback drill still require orchestration and verification. Do not treat an individual passing report as approval of an R6 bound.
