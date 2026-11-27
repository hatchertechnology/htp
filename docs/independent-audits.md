# Independent audit imports and comparisons

HTP accepts S15 `controlled-csv-v1`: UTF-8 `url,rule,state`, where states are `present`, `absent`, or `unknown`. This is an explicit manual interchange, not a general vendor adapter. Exact URL and rule strings are matched; omitted observations remain unknown. The original UTF-8 source and SHA-256 are retained, along with user-supplied provenance. The import form records tool, version, configuration, scope, exported-at, rule definition and notes as a structured object; empty fields stay explicitly unknown, and the browser displays each missing field as "Unknown / not provided". Imports saved before this structured form may carry a free-text provenance string; the browser keeps that text visible as a "Legacy source note" row rather than dropping it. Record source tool/version, configuration, scope, rendering, parser, thresholds, fetch outcomes and rule definitions; missing metadata is unknown. Imported rows and source metadata must not be treated as authenticated claims by the producing tool. Keep independent evidence needed to reproduce them.

The page has two gates. `NUXT_PUBLIC_ROLLOUT_COMPARISONS=true` enables the full import/save/export workflow; `NUXT_PUBLIC_ROLLOUT_COMPARISONS_READ_ONLY=true` enables a default-off read-only mode that loads existing imports and comparisons and downloads original sources but omits import, save and removal controls. Read-only wins if both are set. Neither flag grants database access; held RPCs stay denied until grants are separately enabled.

`s15-metadata-1` maps only `missing_title` and `missing_description`. All other rules are unmapped. A saved comparison pins the source import, SEOsmith receipt, semantics version and the user's assertion about the engine. The assertion is necessary but not sufficient: SEOsmith observations remain unknown unless the report is schema 1, unmodified engine 0.2.0 and ruleset 2026-11-01.1, complete and successful with frontier exhaustion, and the particular page is successfully fetched, untruncated HTML with `is_resource` and `blocked_by_robots` explicitly false and an explicit flags array without extraction, discovery or legacy limits; missing eligibility evidence is unknown. A version string alone does not prove the unmodified engine. Other engines, unknowns, missing pages and incomplete evidence do not establish absence. Agreement is not ground truth. Known disagreements are categorized by which source observed the finding. Differences can reflect scope, rendering, parsing, fetches, thresholds or rule meaning; no proprietary aggregate score is equated. Comparisons are replayed using the pinned semantics version and sources. Unsupported versions are shown as unavailable and their evidence remains exportable. Keep each supported implementation unchanged when adding later versions.

## Semantics `s15-metadata-2` (SEOsmith schema 4)

`s15-metadata-2` is the frozen prior semantics; migration `20261213000000_comparison_semantics_s4.sql` widens the stored check and makes `save_independent_comparison` record it. `s15-metadata-1` stays supported, and saved comparisons replay with the semantics they pinned. The migration is forward-only: R2 rolls back by revoking the comparison grants and deleting the approval row.

It maps the same two rules, `missing_title` and `missing_description`, and still requires the user's assertion. A report is comparable only when it is schema 4 with evidence contract 1, `outcome` is `completed`, `coverage_complete` is true and `evidence_contract.truncated` is false; otherwise every SEOsmith observation is `unknown` (reason `report_not_comparable`). `outcome` is a deliberate fail-closed gate beyond the report-level list in the WP2 plan: a complete-looking report that did not finish `completed` is still not evidence of absence. `evaluation_coverage_complete` is **not** a gate: SEOsmith computes it over all 85 rules, so it is false in every real report. It is information only. A freshly selected schema-1 report is compared with `s15-metadata-1` instead, so a legacy run still replays comparably; it offers no Save button because `save_independent_comparison` records `-2` only. Reports that are neither schema 1 nor a comparable schema 4 render every row unknown and cannot produce a useful saved comparison.

Rows are matched by SEOsmith `entity_id` = `"sha256:" + hex(sha256("seosmith-entity-v1\npage\n" + url))`, hashing the URL exactly as the CSV spells it, with no normalization. Pinned vectors from committed SEOsmith fixtures are in `scripts/comparison-native/vectors.json`; the fixtures are byte copies under `apps/web/tests/fixtures/comparison-s4/`. Per (entity, rule):

- `present`: the evaluation outcome is `fail`.
- `absent`: only for `missing_title`, when the outcome is `pass` and `coverage[rule].unknown` is 0.
- `unknown`: every other case (no evaluation, `unknown` or `not_applicable` outcome, duplicate evaluations, or `coverage[rule].unknown > 0`). The comparison row in the page carries `reason` and `reason_count`, taken for every non-`present`/non-`absent` case from `coverage[rule].unknown_reasons` (largest count first, then key order) and shown verbatim (for example `legacy_not_instrumented`, with its per-rule count). The reason is not part of the REST/RPC payload, and neither a per-row `unknown_reason` nor an outcome string overrides the coverage. Structural reasons that are checked before coverage are `report_not_comparable`, `no_coverage` and `duplicate_evaluation`. When coverage records no reason key the documented fallbacks are `no_evaluation` (only for a missing evaluation), `absence_not_established` (a `pass` that cannot establish absence, i.e. `missing_description`), `coverage_unknown` (an unknown count with no reason keys, carrying that count) and `unknown_outcome`.

`missing_description` can therefore be `present` or `unknown` and is never `absent`: SEOsmith emits `pass` evaluations only for the instrumented `missing_title`. It becomes comparable for absence only in a later semantics version, after SEOsmith instruments the rule.

## Deployment and limitations

Apply `20261124000000_independent_audit_comparisons.sql` before deploying the standalone `/independent-audits` page or a dashboard link. The migration adds new tables and RPCs; existing audit reports and history contracts are unchanged. The functions enforce non-anonymous website ownership. History retains the original hostname and remains visible after a rename; saved comparisons retrieve their pinned report even if the current hostname changes. Website and account deletion are restricted while independent evidence exists. The owner can export all imports and comparisons with their pinned SEOsmith report and original bytes when retained, verify the download, then explicitly delete independent evidence through the page. Deletion requires typed confirmation and an unchanged evidence fingerprint; if evidence changes after export, export again. SEOsmith reports are not removed by this action. Original sources can also be downloaded individually.

This is not production verification. Before activation, test against actual S15 fixture outputs and authenticated end-to-end paths on an isolated site, including denied accounts, imports, replay, and rollback. History uses 100-item keyset pages. The receiver validates CSV grammar and duplicate observations; imports are limited to 4 MiB, 2,000 observations, 8,192 bytes per encoded field, and 256 KiB total decoded URL and rule keys. These bounds are narrower than the offline S15 harness. The browser page requires a verified unmodified controlled engine before comparison can produce known SEOsmith observations; normal production versions will usually remain unknown. No collection is initiated by reads.

Disable access/imports first during rollback. For each website, use the full evidence export, verify that it includes every source and saved comparison with its pinned SEOsmith report, and store the files safely, and explicitly remove the exported records through the owner workflow before using the rollback SQL. The rollback refuses to drop nonempty tables. The owner export is an in-browser download and requires enough browser memory for the full data set. It is an archive, not an automatic restore of saved comparison records; retain a database backup if the records must be restored to HTP after rollback. No producer activation is required. The lifecycle dashboard link must ship after this page; coordinate with the lifecycle owner.

The committed test fixture `apps/web/tests/fixtures/s15-controlled.csv` is copied from SEOsmith S15 at `b46d8f9bfd55400585375baf6315de8039af46d3`; its SHA-256 is `5aa8b90922e2cb648802e06bcfe50f1bd8b9c9a1713bb42de45888e3a223e1b7`. Fixture tests demonstrate interchange behavior, not production crawl accuracy.

The paired `s15-engine-report.json` fixture was generated from the pinned SEOsmith commit using its `s15_controlled` example in labeled mode and `scripts/s15/benchmark.py`; the benchmark reserializes the report. Fixture SHA-256: `8fdabf9915194d036b2915507c89379ac8829c05a4a6ef3323c5421e4e306141`. Binary SHA-256: `08f444afaa91b718427e654dc2587483909e95929b0e715213de50d547904ebe`. It is a controlled transport fixture, not a production crawl.

For a local built preview on `127.0.0.1:3105`, `node apps/web/tests/fixtures/check-independent-audits.mjs` exercises the replay, import/run transitions, unsupported-version handling and export UI with mocked authentication and mocked responses. `node apps/web/tests/fixtures/check-comparison-modes.mjs` (driven by `HTP_COMPARISON_MODE=off|read-only|full|both`) additionally covers the mode gates, import provenance submission, legacy free-text provenance, website/import report-metadata reset and the downstream discrepancy summary. Neither is a live Supabase authentication test.

`apps/web/tests/fixtures/independent-tool-controlled.csv` is a realistic, locally generated `controlled-csv-v1` export (CRLF, quoted fields, mapped and unmapped rules, present/absent/unknown states) with SHA-256 `72742c5d59155fc809c9ac435fd952dd8e0a307be8e087417adab19ffa4f07b5`. It is paired with the controlled `independent-tool-report.json` fixture SHA-256 `ecbacb5d2ba5490b4be2d3a7054c163a79a60f6df87d5d3540ac3a10cb475666`. The unit suite asserts all five discrepancy categories (agreement, independent-only, SEOsmith-only, unknown, unmapped) and exact source bytes. It is a transport fixture, not a production crawl or vendor compatibility claim.

The disposable native fixture `scripts/comparison-native/run.sh read` qualifies the read-only path and `scripts/comparison-native/run.sh full` exercises the normal import path with the realistic export against a loopback PostgreSQL/PostgREST pair, signed owner/nonowner sessions, exact original download and complete discrepancy categories. See `scripts/comparison-native/README.md`. Both strictly local; no hosted grant is enabled.

## Semantics `s15-metadata-3` (page population)

New schema-4 comparisons use `s15-metadata-3`; the frozen `-1` and `-2` implementations and saved pins remain supported. A completed, coverage-complete schema-4 report with contract version 1 can establish `missing_title` absence for a page with a pass only when the raw population is provably complete: the title coverage entity count equals the raw page count, observations plus omitted observations equal that count, every URL is unique and has an explicit resource classification, every retained observation identifies its raw entry, and each non-resource entity has exactly one known title evaluation. Resource unknowns and contract truncation are allowed when that proof holds. Missing, ambiguous or unverifiable population or page evaluations fail closed. A page evaluated as `not_applicable` stays unknown with reason `not_applicable` and no rule-wide omission count. `missing_description` is never inferred absent. A known page evaluation failure remains present once the page population is verified. This proof is scoped to the report's declared crawl and does not prove a site is defect-free.

Migration `20261216000000_comparison_semantics_page.sql` must be applied first, followed by the API and then the web client. The old four-argument save RPC continues to pin `-2` for old open clients; new clients call `save_independent_comparison_versioned` with `-3`. Its execute grant mirrors the existing authenticated grant at migration time. If the pilot is enabled later, explicitly grant both save functions; pilot disable must revoke both. Keep the old RPC available while old clients can save. A schema-1 selection continues to use `-1` and is not saveable through the new path. Existing exports and replays carry their saved semantics.

### Roll back to the previous comparison client

Keep the `s15-metadata-3` web bundle in full mode and the compatible API serving owner reads while fencing saves. Full mode keeps owner replay and full evidence export available. Use a privileged database connection and run each SQL block in order with `psql -X -v ON_ERROR_STOP=1` against the same database. Stop on any error and verify the live state before proceeding.

1. Close both comparison save RPCs. The REST API forwards the caller's identity to these same RPCs, so the database fence covers static clients and direct Supabase callers, including open tabs. `HTP_ROLLOUT_COMPARISONS_READ_ONLY=true` can also close REST writes, but direct Supabase calls still require the database fence. Keep the existing owner history, detail and fingerprint grants so owners can replay and export. The full pilot-disable SQL revokes these reads as well.

   ```sql
   begin;
   revoke execute on function
     public.save_independent_comparison(uuid,uuid,uuid,boolean),
     public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text)
     from public, anon, authenticated, service_role;
   do $$
   begin
     if exists (
       select 1 from unnest(array['anon', 'authenticated', 'service_role']) as caller(role_name)
       cross join unnest(array[
         'public.save_independent_comparison(uuid,uuid,uuid,boolean)',
         'public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text)'
       ]) as save(signature)
       where has_function_privilege(caller.role_name, save.signature, 'EXECUTE')
     ) then
       raise exception 'comparison save still granted';
     end if;
   end $$;
   commit;
   ```

2. Drain transactions already writing comparison rows and fence any already-admitted `-3` save that has yet to reach its insert. Adding the `NOT VALID` check takes an exclusive table lock, which waits for existing writers to finish. After commit the check rejects later `-3` inserts while retaining stored `-3` rows. A timeout leaves the RPC hold in place. Resolve the blocking transaction and finish this step before counting. Run the count after the check commits, using a fresh snapshot.

   ```sql
   begin;
   set local lock_timeout = '5s';
   alter table public.independent_audit_comparisons
     add constraint independent_audit_comparisons_hold_s15_metadata_3
     check (semantics <> 's15-metadata-3') not valid;
   commit;

   select count(*) as stored_s15_metadata_3
   from public.independent_audit_comparisons
   where semantics = 's15-metadata-3';
   ```

3. If the count is nonzero, keep the `s15-metadata-3` web bundle and compatible API. Owners can replay and export with that bundle. If an owner elects to remove evidence, have them verify the full export and use the fingerprint-checked owner deletion workflow, which removes all independent evidence for that website. Recount after deletion with the fence still in place. If you set the API read-only flag in step 1, it also blocks REST deletion. Use the compatible API with that flag off for the approved deletion while keeping the database save fence in place.
4. At zero, restore the previous web bundle first, then the previous API. Verify owner replay of saved `-1` and `-2` comparisons on the restored stack. Leave the additive migration applied. Keep the `-3` check and the versioned RPC hold through old-client-only operation.
5. If legacy pilot writes were enabled before the rollback and may resume, grant only the four-argument save to `authenticated`. Restore the REST write setting for the legacy client if it was held. Verify a legacy save pins `-2` and the versioned RPC is still denied. A stale `-3` SSR tab calls the held RPC directly. A stale `-3` static tab sends an explicit `semantics` field, which the previous API rejects. Reload those tabs to use the previous bundle.

   ```sql
   grant execute on function public.save_independent_comparison(uuid,uuid,uuid,boolean)
     to authenticated;
   select has_function_privilege('authenticated',
     'public.save_independent_comparison(uuid,uuid,uuid,boolean)', 'EXECUTE') as legacy_enabled,
     has_function_privilege('authenticated',
     'public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text)', 'EXECUTE') as versioned_enabled;
   ```

   Expect `legacy_enabled = true` and `versioned_enabled = false`. For a later approved `-3` rollout, restore a compatible API and reader before dropping `independent_audit_comparisons_hold_s15_metadata_3` and restoring the versioned grant.

The Kerry regression projections in `apps/web/tests/fixtures/comparison-s15-page` retain population identities, rule evaluations and coverage from the saved 100/3000 complete report (source SHA-256 `dfa522652cfd32fd22eaf10f8c55b6f8e15e71cc8aeac4c34505343d9ab95a9a`) and the partial 100/400 report (`49b5d02544f09e14521da5d215428d3343120a682bd9a726cc2e940088d1a33b`). They are reduced test projections, not full admissible reports or evidence of a fresh production crawl.
