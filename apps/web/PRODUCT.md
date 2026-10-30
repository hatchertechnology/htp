# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Nuxt and Nuxt UI frontend, Rust API, Supabase authentication and website records,
Google Analytics Data API, Google Search Console and URL Inspection APIs, Fly hosting at htp.hatchtech.dev.

## Product Purpose

Help users review overall performance for their client websites by selecting a
website and reading real Google Analytics data in one clear dashboard.

## Capabilities and Constraints

- Users can create, list, rename and delete their own website records.
- Each website can have a numeric GA4 property binding; Google checks report access.
- Browser users connect their own Google account using read-only Analytics and Search Console OAuth.
- Overview leads with Search Console clicks, impressions, CTR, position, daily search trends, top queries and landing pages. The user explicitly requested Search first.
- URL Inspection reads indexed status, crawl and canonical information for one page. All integrations are read-only.
- Onsite reporting includes aggregate users, sessions, views and engagement, a daily traffic
  chart, acquisition channels, top pages, and device shares for a date range.
- Supabase isolates website records by owner. Google refresh credentials are
  encrypted in service-only database storage bound to that owner. A Supabase Edge
  Function collects hourly snapshots, including while the user is signed out.
- Dashboards read saved reports and show freshness, queued work, and sync errors.
  Disconnecting Google stops updates across devices and keeps report history.
- Authentication, empty reports, thresholds, connection failures and quota errors
  must be explicit. No synthetic metrics appear in the application.
- The Rust API remains at htp-api-kerry-hatcher.fly.dev. Developer tools remain
  accessible under /developer but are not primary dashboard navigation.

## Users

Website managers reviewing client performance and deciding what to investigate.
Google Search performance comes first; detailed acquisition and content reports support it.

## Brand Commitments

Hatch / The Hatch Tech Platform. The user requested a new visual identity and chose
Operations Desk with a search-first overview (extended from the original traffic-first composition): navy, ivory, rust, fine rules.
