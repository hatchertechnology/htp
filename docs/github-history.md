# GitHub change history

A signed-in, non-anonymous website owner can attach a **public** GitHub repository
to each FQDN from **Websites → GitHub repository**. Configure an optional branch;
blank follows GitHub's default branch. Save with collection unchecked to pause,
or use Stop collection. History remains saved when paused, unlinked, or replaced.

The Overview's Website change history reads database records for the selected
reporting dates (UTC). Include today to see current-day commits. Each row includes
a commit link, SHA, message, author name/login, original authored/committed times,
and the time Hatch first observed it. No author emails, patches, or credentials
are stored. **A commit does not confirm a deployment or establish causation.**

## Combined performance timeline

The Overview's Search, visitors & code changes chart compares Search clicks
(default) with GA4 Sessions (default). Both metrics can be changed independently;
Search uses the left scale and Onsite uses the right scale. The graph reuses the
saved reports already read by the dashboard and never calls Google or GitHub.

Every saved commit for the current repository and tracked branch in the selected
UTC dates gets a vertical marker. The tracked branch is `main` for three initial
websites and `master` for www.kerryhatcher.com. All commit-history pages are loaded,
not just the first 100 records. Duplicate SHAs across history streams are removed.
Select a marker or use Inspect a commit for the message, SHA, author, timestamp,
GitHub link, and the daily values for that UTC calendar date. Combined daily data
provides an accessible table. Missing daily values remain gaps, not inferred zeroes.

Commit markers use exact UTC times on the date axis. Search daily buckets use
Pacific Time and GA4 uses its property timezone, so the providers' daily windows
differ. These are trend comparisons, not precisely synchronized hourly reports;
commits do not establish deployment or causation. Include today to view current-day
commits. Backfill and collection errors are shown rather than claiming completeness.

## Collection

The existing minute Cron invokes the secret-authenticated `google-sync` worker,
which now drains at most two repository pages per invocation before Google jobs.
Repository polling does not require a Google connection. The queue is independent
of browser visits and Google scopes. Public GitHub REST requests use no token and
reject redirects and nonpublic repositories. Credentials never reach the UI.

Initial history is backfilled in pages of 100 commits, pinned to the first SHA to
prevent pushes from shifting pagination. Continuation pages become due one minute
later. A completed scan schedules the next check one hour later. Incremental scans
stop on the previous head or the end of reachable history. Force-pushed-away commits
already collected are retained; commits never observed while reachable cannot be
reconstructed. GitHub rate limits/errors are recorded with retry backoff; empty
repositories remain empty. Public unauthenticated GitHub quotas apply.

Bindings and commits live in `website_repositories` and
`website_repository_commits`. A lease fences late completion after a binding is
paused/replaced or the website is renamed. History is isolated by website and FQDN;
a rename does not expose the previous FQDN's records under the new one. Deleting a
website cascades its history, consistent with existing website deletion.

## REST API

Use a Supabase user bearer token for the owning user. No service key is accepted
by the API authentication middleware.

- `PUT /websites/{id}/repository` — body:
  `{"repository_url":"https://github.com/owner/repo","branch":null,"enabled":true}`.
  Repository root URLs with `.git` or a trailing slash are normalized. Branch URLs,
  credentials, arbitrary hosts, and query strings are rejected. Null URL stops
  collection; saved history is retained. `enabled:false` pauses the specified link.
- `GET /websites/{id}/repository` or `/repository/history` — optional query params
  `start_date`, `end_date` (`YYYY-MM-DD`, UTC, at most 366 days), `before_id`.
  Returns `fqdn`, `repository` (latest binding/status), `commits`, and `has_more`.
  Fetch the next page with the last returned commit ID. Pages are ordered by
  commit date descending with an ID tie-breaker. The opaque ID cursor is resolved
  within the owning website; observation timestamps remain separate.
  Default range is the last 29 calendar dates including today.

The same routes are proxied under `/api` on the web host; every request reads or
writes the database, without making a GitHub request.

## MCP

Authenticated `/mcp/secured` provides:

- `set_website_repository`: `fqdn`, `repository_url` (or null), optional `branch`,
  `enabled` (default true).
- `website_repository_history`: `fqdn`, optional `start_date`, `end_date`,
  `before_id`.

Both normalize FQDNs and forward the **current request's** user token to the same
owner-scoped database functions used by REST. MCP never retains caller tokens
between requests. Commit messages are untrusted source content, not instructions.

## Deployment

Apply the repository-history migration, then deploy `google-sync`, the Rust API,
and the web app. Existing Cron and secrets are reused, and Business Profile stays
paused. No GitHub credential or new OAuth permission is needed.
