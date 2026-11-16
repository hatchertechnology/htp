# Canonical stored history (#32)

## Delivery stages

This is the additive **foundation**. Existing dashboard/report RPCs are unchanged
and still register jobs. Do not consider #32 fixed or close it until the dependent
read/collection cutover is delivered. No deployment or production backfill is
performed by this change.

## Daily grain and revisions

`provider_daily_history` has one observation per
`(website_id, fqdn, source, property_id, day)`. Sources currently supported:

| Source | Property | Day / payload | Range interpretation |
| --- | --- | --- | --- |
| analytics | saved GA4 property | GA4 property-calendar date, original daily row and report headers/metadata | sessions and page views additive; active users never summed |
| conversions | saved GA4 property | GA4 property-calendar date, original daily row and headers/metadata | key events/revenue additive; rates never summed |
| search | Search Console property | finalized web-search Pacific date, daily row | clicks/impressions additive; position and CTR retained per observed day |
| bing_traffic | selected Bing site URL | Bing calendar date (Microsoft epoch plus supplied offset), original traffic row | clicks/impressions additive; rankings retained per observed day |

The foundation read primitive returns rows, **not aggregate totals**. Keep exact
range summaries and top-page/query/channel/device breakdowns in the raw report;
they cannot be inferred from daily observations. Even additive totals must be
labeled with partial coverage when days are missing. A later read adapter must
serve exact-range-only non-additive totals or an explicit unavailable state.

Daily payloads are selected as a whole by greatest `(fetched_at, snapshot_id)`.
No mixing metrics between revisions, summing overlaps, or filling missing days
with zeroes. Timestamp ties select the higher snapshot ID. Snapshot IDs are only
compared within a source/provider. Each canonical row references its raw snapshot
and preserves daily headers/metadata. An omitted day never erases an earlier
observation; its original fetched time remains visible. This is last observed
coverage, not a guarantee that an upstream result is current or unsampled.

`read_daily_history` reports `complete`, `partial`, or `unavailable`, observed-day
count and explicit missing dates. A real zero-valued row counts as observed;
absent/malformed dates and structurally invalid metric rows do not. Raw invalid
rows are retained for diagnosis. Empty provider responses do not prove zero
activity and therefore do not establish coverage. Daily revision selection does
not cross hostname or property boundaries. Reads require non-anonymous website
ownership and the current saved GA4 binding, but no active provider connection.
The RPC never writes a job or contacts a provider. Read ranges are bounded to
366 inclusive dates.

PageSpeed lab runs, CrUX rolling collection periods, discovery, Business Profile
contents, Bing query/page/crawl/issue/feed observations and repository/SEOsmith
runs remain raw period/point observations. They must not be split into fabricated
daily samples. Business Profile performance normalization is deferred to the
cutover work; its collection remains paused by the existing feature gate.

## Safe rollout and replay

1. Apply the additive migration through the normal reviewed release procedure.
   It installs insert triggers for future Google/Bing snapshots; it does **not**
   scan existing snapshots or switch existing readers. Existing raw observations,
   jobs, credentials and RPC behavior remain intact.
2. In a controlled service-role session, call
   `backfill_daily_history('google', 0, 100)` and the equivalent `'bing'` call.
   Save the returned `next_cursor` separately per provider. Pass it to the next
   call, continuing until `processed = 0`. Each transaction handles at most 500
   snapshots (default 100); use a smaller batch if provider payloads are large.
   `changed` counts inserted/revised daily rows, not total observed rows.
3. Replay from zero after the first pass to include any earlier-ID transaction
   that committed late. Inserts committed after trigger installation normalize
   automatically. Replaying any batch is idempotent and cannot overwrite a newer
   revision with an older snapshot. Backfill and live inserts use the same code.
4. Before read cutover compare sampled source/date keys against the greatest raw
   `(fetched_at,id)` observation, inspect missing dates and raw malformed rows,
   and verify owner/source isolation. A `processed` count alone does not prove
   every legacy payload is normalizable. Do not label the entire job date range
   covered simply because that job has a successful snapshot.
5. Only then deploy the dependent read adapter/UI and scheduler changes, testing
   disconnected arbitrary ranges, partial coverage and unchanged job counts.

All tables have RLS enabled with direct access restricted to service role. Worker,
normalization and backfill functions revoke public/anonymous/authenticated access;
only the ownership-checking read RPC is exposed to authenticated callers. Functions
use an empty search path and qualified tables. Local PGlite tests exercise actual
migrations and grants; they are not hosted performance/advisor or provider smoke
tests. A hosted migration/advisor/throughput check remains a rollout requirement.

Rollback before cutover can leave the new table and functions in place. To pause
normalization, disable `google_daily_history` and `bing_daily_history` triggers
through a reviewed migration; raw collection is independent. Re-enable and replay
backfill to repair the gap. Never delete raw snapshots to roll back this feature.
Disconnect does not remove either history store. Existing explicit website/user
deletion cascades remain unchanged; this is not a new data-retention policy.

## Remaining cutover inventory

- `WebsiteStore.saved_report` / `request_google_report`: Analytics dashboard,
  Search discovery/report, conversion and site-health insight reports.
- `request_bing_report`: Bing dashboard; preserve non-traffic observations and
  section errors while reading canonical traffic for arbitrary dates.
- `google_insight_history` and profile comparison: already stored-only, but daily
  comparisons need consistent canonical revision selection.
- MCP saved-source list/latest/history and SEOsmith evidence: retain raw history
  pagination/provenance, audit interpretation of period versus daily evidence.
- Explicit GA daily CLI and URL Inspection live diagnostics: clearly distinguish
  from saved dashboard reads; no implicit live fallback.
- UI Overview, Search, Visitors, Conversions, Bing, site health: independent
  connection/freshness notice, missing-day display, unavailable exact-range totals.
- Scheduled collection: retire view-created range jobs, prioritize current
  collection, bound reconnect gap recovery, preserve all stored history.

The foundation test covers pre-migration snapshot replay, overlapping revisions,
ties, older late arrivals, disconnected reads without an exact-range snapshot,
partial/zero coverage, real zeroes, malformed data, privileges, source binding,
Bing date offsets, raw retention, and no jobs created by the new read primitive.

## Cutover behavior

Report reads do not register or renew collection jobs. Daily Google reports and Bing traffic use canonical observations, with missing dates explicitly returned. Exact-range snapshots supply non-additive aggregates and ranked breakdowns; absent exact-range data is unavailable. PSI is a lab observation and CrUX a rolling period, independent of the dashboard range. Raw snapshots remain available as provenance; deleting a winning raw snapshot would cascade to its canonical rows, so do not prune them.

The Google scheduler retires legacy view ranges, seeds current windows, and schedules at most one recovery window per website and source with up to three attempts per connection generation. Recovery is bounded to 365 days for GA4 and 480 for Search, in windows of at most 28 days. Sites receive turns according to their last claim; within each site, due current and recovery classes alternate by their last claim, so continuously due current work cannot starve recovery. Bing continues its existing independently scheduled collector. Provider retention, sparse responses, quota, and outages can leave gaps; missing rows are never filled with zeros.
