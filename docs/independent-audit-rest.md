# Static Independent Audit owner REST

Based on exact stacked PR114 `ad52a03ff2bc6a6dac1007515c46dcd98174fa89`.

The static Independent Audit page uses seven fixed owner operations through `WebsiteStore`. The legacy dashboard still makes the same Supabase RPC calls with the same arguments/results. No general RPC route, privileged credential, migration, grant, approval or default is introduced. Success JSON is retained without projecting evidence fields or interpreting future semantics.

| Owner REST method/path under `/websites/{id}` | Existing RPC |
| --- | --- |
| GET `independent-audits` | `independent_audit_history` with null source ID and cursor |
| GET `independent-audits/{item}` | `independent_audit_history` with source ID |
| GET `independent-comparisons` | `independent_comparison_history` |
| GET `independent-comparisons/{item}` | `independent_comparison_detail` |
| GET `independent-evidence/fingerprint` | `independent_evidence_fingerprint` |
| POST `independent-audits` | `import_independent_audit` |
| POST `independent-comparisons` | `save_independent_comparison` |
| DELETE `independent-evidence` | `delete_independent_audit_evidence` |

POST import accepts `{format,source,metadata}`; save accepts `{import_id,delivery_id,asserted}`; DELETE accepts `{confirmation,export_fingerprint}`. Rust deserializes closed typed inputs and UUID paths. No caller can supply a database function name, website owner or SQL argument map. History uses only `before`/`before_id`; the database retains cursor validation, ordering and 100-row pagination. A missing detail remains HTTP 200 JSON null. Known SQLSTATE 22023 validation labels remain HTTP 400, including `evidence_changed_export_again`. Owner/held ACL rejection remains 401/403; other upstream error status codes remain failures with sanitized text. Transport/decode failure uses the store's existing 503 behavior. Arbitrary database detail is not disclosed. Successful and handled RPC error responses are no-store.

Authentication runs before the API rollout gate. `HTP_ROLLOUT_COMPARISONS=true` permits reads and writes. `HTP_ROLLOUT_COMPARISONS_READ_ONLY=true` permits reads and denies writes, even when both flags are true. Both default false. The existing `NUXT_PUBLIC_ROLLOUT_COMPARISONS` and `NUXT_PUBLIC_ROLLOUT_COMPARISONS_READ_ONLY` retain their defaults and read-only precedence. UI and API settings are independent availability controls; neither grants database access. The legacy direct client remains governed by its existing UI flags and database controls.

The browser uses `useWorkspace.request` for the owner bearer and session check, fixed API-origin paths, no retries and redirect refusal for the new operations. Supporting SEOsmith run history/detail use the existing closed saved-report path resolver. CORS extends only to these exact UUID resource shapes and implemented methods under the existing single-origin, authorization/content-type-only, credential-free policy.

The decoded source limit remains inclusive 4,194,304 UTF-8 bytes. A 32 MiB JSON envelope accommodates worst-case JSON escaping without lowering the raw limit. Source text, BOM, Unicode, line endings, metadata and assertion false are forwarded unchanged. The database still validates CSV, metadata's 65,536-byte jsonb representation, ownership, hostname pairing and pinned immutable receipts. The page retains source downloads, legacy provenance, unsupported semantics, selection/generation resets and report replay.

The export controller still reads a fingerprint, traverses all source and comparison pages and details (including pinned raw SEOsmith report JSON and prior hostnames), then compares a second fingerprint before preparing the download/proof. Removal still requires the exact phrase, prior export proof, explicit `window.confirm`, and the database's locked fingerprint comparison. The facade neither invents a proof nor substitutes pilot cleanup. The browser's existing instruction to verify the downloaded file remains.

## Release prerequisites and verification limits

`20261124000000_independent_audit_comparisons.sql` defines the seven contracts and independent ownership checks. `20261205000000_comparison_pilot_scope.sql` replaces their owner lookup with a locked, caller-bound owner/site pilot helper and retains authenticated/PUBLIC/anon execute holds. The approval table defaults empty. REST deliberately cannot overcome either the held grants or missing approved scope. A separately reviewed release would need to satisfy these existing controls; this change does not enable them or assert hosted migration state. Enabling UI/API flags alone is insufficient.

All new tests are synthetic page-controller, transport or loopback HTTP fixtures. No real source was imported or evidence removed; no hosted endpoint or database was contacted. Page-controller tests exercise the actual extracted TypeScript controller without rendering a browser; they do not qualify native download handling, real authentication, or an approved database release. Existing migration/SQL controls were inspected, not modified or executed. No visual or hosted rollout claim is made.
