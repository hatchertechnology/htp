# Disposable host-quota concurrency fixture

This fixture writes synthetic accounts and hosts. Use only a fresh, isolated local PostgreSQL/PostgREST instance; never point it at a hosted or shared database. The Node script rejects non-loopback URLs and requires the explicit `FORMS_QUOTA_FIXTURE=disposable` marker. Its JWT signing key is a fixed public test string, not a real secret.

Prepare a disposable PostgreSQL database with the `anon`, `authenticated` and `service_role` roles and synthetic `auth.uid()` / `auth.jwt()` helpers. Apply the website migration and forms migrations 000–009, with the intended staged authenticated grant holds, then apply `20261128000000_forms_host_challenge_quota.sql` in a single transaction. Load `forms-host-quota-concurrency.sql` once into this empty disposable database. Start local PostgREST using database role `authenticator`, anonymous role `anon`, public schema, and the synthetic JWT signing key `local-test-secret-at-least-32-bytes-long`. Set the loopback URL to its actual port and run:

```sh
FORMS_QUOTA_FIXTURE=disposable FORMS_QUOTA_FIXTURE_URL=http://127.0.0.1:56642/ node supabase/tests/fixtures/forms-host-quota-concurrency.mjs
```

The script checks parallel account-window, account-host and website-host boundaries, same-host rotations, and anonymous/cross-owner denial. The database is deliberately changed and the fixture is not repeatable without rebuilding it. Destroy the disposable database and local server after testing. This fixture does not prove migration-ledger atomicity, hosted role inheritance, multi-account abuse resistance or production lock performance.
