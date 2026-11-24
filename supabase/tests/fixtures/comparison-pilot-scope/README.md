# Comparison pilot scope fixtures

`concurrency-pg17.py` is a synthetic, disposable PG17 fixture for the
`20261205000000_comparison_pilot_scope.sql` lock and rollback semantics. It
starts one loopback-only container from the cached
`public.ecr.aws/supabase/postgres:17.11.0.004` image with a temporary data
directory, applies the website, SEOsmith audit, comparison and pilot
migrations, and removes the container on exit. It never pulls an image, reads
hosted credentials or connects to a hosted service.

The fixture proves three normal cooperative cases:

- **Gate removal serialization.** An in-flight `import_independent_audit` holds
  the approval/website share lock. A concurrent `DELETE` of the approval waits
  for it, then invalidates the pair; the committed import remains and the next
  owner read is denied.
- **Scoped cleanup serialization.** An in-flight
  `delete_comparison_pilot_evidence` holds the website row exclusively. A
  concurrent ownership transfer waits, then observes the committed post-cleanup
  rows.
- **Rollback preservation.** A scoped cleanup whose expected identities or
  fingerprint do not match rejects before deleting anything, releases its lock,
  and a later approval removal is not blocked.

Run it from the repository root:

```bash
python3 supabase/tests/fixtures/comparison-pilot-scope/concurrency-pg17.py
```

It requires a working `docker` (or a `docker` shim over Podman) and the cached
image above. It is not part of the hosted release; it is disposable fixture
evidence only.

The default-empty gate, held-ACL and bounded-cleanup behavior is also covered
without containers by `supabase/tests/comparison-pilot-scope.test.mjs`.
