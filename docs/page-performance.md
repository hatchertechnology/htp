# Priority-page performance samples (H09)

The existing Site health reports remain independent of crawler/browser-worker evidence. PageSpeed collects one Lighthouse lab run per device; CrUX collects eligible Chrome users' p75 field data. A sample can represent a priority page or one template example, but does not establish the performance of every page using that template.

## Contract and bounds

The existing authenticated `POST /websites/{id}/insights/report` and `/insights/history` routes accept `kind`, `property_id`, `start_date`, and `end_date`; no new provider credentials or public endpoints are added.

Legacy source identities are unchanged: PageSpeed `mobile` / `desktop` test the HTTPS homepage; CrUX `PHONE` / `DESKTOP` measure the HTTPS origin. A URL sample uses `device|https://exact.website.host/path?query`. Examples:

- `mobile|https://www.example.com/services`
- `PHONE|https://www.example.com/services`

The browser normalizes relative paths and URLs before registration. Samples must use HTTPS on the website's exact hostname, without credentials, a custom port, or a fragment. The collector independently parses the URL and rejects noncanonical sources before calling a fixed Google API endpoint. It never directly fetches the supplied website URL. Redirected Lighthouse pages retain the provider's requested/final URLs; redirects do not authorize additional sample hosts.

The registration transaction locks the owned website row and permits at most **ten distinct active sampled URLs** across both providers and devices, within the existing 100-active-job limit. Each requested source uses the existing daily cadence and seven-day refresh horizon. Visits/polling extend that source's horizon; sources expire seven days after their last request. Choosing another source does not cancel an already scheduled source. Google connection, API-key configuration, lease, generation and hostname fences remain unchanged. No refreshed OAuth token is sent for public performance requests.

Date ranges select observation history in UTC, not the period of the latest measurement. History remains readable after disconnect; a website rename isolates the prior hostname's history. History includes up to 200 known sample URLs for selection, while complete sources and reports remain available through the existing paginated MCP saved-data interface.

## Evidence and interpretation

New snapshots add `measurement` with `semantics_version: 1`, `mode: lab|field`, `scope: url|origin`, `target`, and `device`. Lighthouse adds `sample_count: 1` and LCP/CLS/FCP/TBT numeric metrics (null when absent). The original retained Lighthouse result includes version, fetch time, environment, configuration/throttling, diagnostics, and requested/final URLs. Embedded screenshots remain omitted. Compact history removes audit details but now preserves environment, version, metrics and source provenance. Older snapshots without these fields remain readable; unavailable historical provenance is not reconstructed.

CrUX retains the original `record.key`, collection period, metrics, and URL normalization information. A missing URL record is saved as `available: false, reason: insufficient_data`; there is **no automatic origin fallback**. Origin data is selected separately. Collection windows overlap and are not independent daily samples. A lab TBT value is not field INP, a single run has no estimated spread, and missing/malformed metrics are unavailable rather than zero or a passing assessment.

Source and normalized CrUX identities are retained in the raw evidence. URL samples use the requested exact URL; Google can normalize that URL in its response. Cross-run tool/environment differences must be considered before drawing conclusions.

Asset attribution and rendered diagnostics from S08/S11/S12 are later enrichments tracked by the shared roadmap. This change does not invent those observations or require them for provider reports. It implements the independently useful provider-sampling portion of HTP #14; that issue remains open for the cross-source joins.

## Rollout, gate and rollback

1. Deploy the updated `google-sync` collector first. Existing legacy jobs continue to work.
2. Apply `20261101060136_page_performance_samples.sql`. It enables bounded source registration and extends compact history; it adds no tables or exposed grants for the validation helper. Test authenticated ownership and a sample request in staging.
3. Deploy Nuxt. The sample form is gated by `NUXT_PUBLIC_PAGE_PERFORMANCE_SAMPLES`, default **false**. Enable it only after steps 1–2, with existing PageSpeed/CrUX API keys configured.
4. Verify mobile/desktop homepage and origin reports, then one sampled URL on both providers. Confirm actual scheduled completion, absent URL traffic, raw provenance, reload/selection and independent history. Fixture tests do not establish live Google availability, quotas, or production readiness.

To roll back the UI, set the gate to false. To stop sampled collection while preserving historical evidence, expire only the sampled performance jobs before reverting the collector:

```sql
update public.google_report_jobs
set refresh_until=now(), lease=null, leased_until=null
where kind in ('pagespeed','crux') and strpos(property_id,'|')>0;
```

Keep the backward-compatible history function and snapshots. If registration must also be disabled during a collector rollback, restore the previous `request_google_report` definition from `20261030213944_pause_business_profile.sql` (the single function and its grants, not the whole migration). An in-flight completion using a cleared lease is rejected by existing fencing.

## Verification

- `npm test --prefix supabase`: actual PostgreSQL-compatible migration queries test ownership, anonymous exclusion, invalid sources, distinct-URL bounds, sample expiry, retained history/provenance, disconnect and rename isolation, plus existing queue/fencing regressions.
- `deno test --allow-env supabase/functions/google-sync`: fixed-endpoint provider stubs verify exact URL/device requests, unavailable field data, original legacy behavior and worker error/fencing behavior.
- `npm run typecheck`, `npm test`, and `npm run build` in `apps/web`.
- Browser QA uses a local production build with mocked authenticated reports; it does not create accounts or contact live providers.

Provider definitions: [PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/about), [CrUX API](https://developer.chrome.com/docs/crux/api).
