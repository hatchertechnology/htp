# SEOsmith target lookup: local PostgreSQL 17.11

Synthetic fixture measurements on a disposable local Supabase PostgreSQL 17.11 container. The candidate-installing harness and captured results are in `supabase/benchmarks/seosmith-pg17/`. Run `supabase/benchmarks/seosmith-pg17/run.sh "$PWD" 0` from the repository root with Podman, Node.js and the Supabase PostgreSQL 17.11 image available. The harness creates a disposable local container and synthetic data; it does not contact a hosted database. Times are single runs, not production estimates; some baseline measurements overlapped diagnostic work.

| Fixture | Bytes | Pages | Pre-H01 ingest |
| --- | ---: | ---: | ---: |
| 1 MiB target | 1,076,118 | 2,831 | 1,192 ms |
| 2 MiB target | 2,152,380 | 5,661 | 4,438 ms |
| 4 MiB target | 4,305,054 | 11,321 | 17,005 ms |
| 8 MiB target | 7,232,289 | 19,000 | 55,596 ms |

The 11,321-page relationship query's `EXPLAIN ANALYZE` showed a nested-loop left join with 85,443,360 rows removed by the join filter and 12,787 ms execution time. A diagnostic existence lookup used a hashed subplan and took 249 ms; that isolated diagnostic omitted the policy exclusion, which the actual migration retains.

On the 19,000-page fixture, post-H01 ingestion took 62,795 ms and retry 29,484 ms. After installing this migration in the same disposable container, a new delivery took 882 ms and retry 594 ms. Deriving cached summaries for five original large/padded rows took 1,072 ms. All four page-heavy fixtures yielded equal full legacy summaries before and after the rewrite. The new delivery's stored raw bytes and SHA-256 matched its submitted text.

The H01 migration's original backfill ran before this migration and took 42,947 ms for five large/padded synthetic rows. This additive migration does not accelerate that initial backfill. Production ordering requires a separately reviewed plan; do not rewrite already approved migration history silently.
