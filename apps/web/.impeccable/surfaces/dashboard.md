# Website overview
Mode: Operate.
Approved direction: Operations Desk, Search-first.
Approved visual-world reference: .impeccable/mocks/operations-b.png.
The reference establishes materials; the direction contract below establishes the
finished dashboard order. Illustrative reference figures do not ship.

## Direction contract — Google Search extension
THESIS: Lead the website overview with discovery in Google Search, then connect it
to onsite traffic. Preserve the Operations Desk visual world.
OWN-WORLD: Existing navy rail, ivory workspace, rust chart, ruled white reports,
and self-hosted Encode Sans. No new decorative materials.
STORY: Select a website and accessible Search Console property; review clicks,
impressions, CTR and position; inspect a specific page's indexed status, crawl
information and canonical URL. Analytics loads independently below. Google
integrations use read-only access.
FIRST VIEWPORT: Shared site/date controls, overview heading, Search performance
heading and property selector, prominent daily search chart with four totals;
queries and landing pages below, followed by URL Inspection and Analytics.
FORM: Local extension of the approved Operations Desk surface; no concept seed
required. Signature interaction: a ranked landing page fills and focuses the
inspection field. Website/property changes clear report and URL results before
loading. Editing the URL clears inspection results and cancels pending inspection.
FINISH: Finish review and documentation describe the final read-only dashboard.
The incumbent DESIGN.md and .impeccable/design.json remain the visual authority;
this ordinary extension does not regenerate their tokens or component examples.

## Finished implementation
`app/components/SearchDashboard.vue` precedes the independent Analytics report in
`app/pages/index.vue`. Shared website/date controls remain in
`app/components/AppShell.vue`. The Search Console property selector sits beside
the Search heading. The chart switches between clicks and impressions and updates
its accessible Daily data table; four totals show clicks, impressions, CTR and
average position. Queries and landing pages follow, then URL Inspection, then
onsite Analytics with its chart, totals, channels, top pages and device shares.

URL Inspection describes Google's indexed version, with verdict, last crawl,
robots.txt status, indexing permission, page fetch status and canonical URL when
reported. A result can link to Search Console. It does not run a live test or
request indexing. Connections lists Analytics and Search Console/URL Inspection
access independently. Missing authorization, properties or data retain explicit
next actions; unavailable measurements remain empty rather than invented.

Analytics retains its own requests, loading/error states and refresh. Website
selection resets and reloads bound reports, preventing another site's data from
remaining visible. No sample profile, prior-period comparison or fixture metrics
ship in the application.

## Responsive expression and motion
The Search chart inherits the existing 263px desktop totals column (220px below
1280px). Search rankings are side by side on wide screens and stack below 1280px.
Analytics lower reports form two columns below 1280px. At 960px navigation becomes
a horizontal strip and Connections stacks. At 650px the chart precedes a
two-column totals grid, property controls wrap, ranked tables scroll horizontally,
the URL form stacks and inspection details use one column. Analytics lower
reports become a single column.

Navigation/link state changes use 160ms cubic-bezier(.16,1,.3,1); inherited button
transitions use 160ms ease-out. The chart filter transition is declared at 180ms.
Content stays visible by default; reduced motion disables transitions/animations.

## Review evidence
Source documentation checked against `app/assets/css/main.css`,
`app/components/SearchDashboard.vue`, `app/pages/index.vue`,
`app/pages/connections.vue`, `app/components/AppShell.vue`, `PRODUCT.md`,
`DESIGN.md` and `.impeccable/design.json`.
Final browser validation uses the built-in browser; final capture destinations are
`.impeccable/review/search-desktop.png`, `search-mobile.png`,
`search-url-tools.png` and `search-connections-mobile.png` in that same directory.
Review fixtures are evidence, not shipping assets or production data.
