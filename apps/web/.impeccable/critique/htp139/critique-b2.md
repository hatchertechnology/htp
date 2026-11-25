# htp#139 — Stage B2 critique re-run (browser evidence)

Supersedes the round-1 source-only critique in the plan (§1, scored 23/40).
Evidence: 20 full-page captures at 1280×800 and 390×844 under
`/mnt/storage/worktrees/plans/htp139-evidence/polish/` (overview, open date
menu, open user menu, websites, forms responses, forms setup, connections,
independent-audits, sign-in, oauth consent), rendered from the integrated
static artifact with the Forms pilot and read-only comparisons baked in, the
synthetic session from `tests/fixtures/check-shell-static.mjs`, browser zone
America/New_York, and zero `pageerror`s. The launcher build only ships the
`detect` command, so the mechanical pass is `detect --json` (committed as
`detect.json`) and this critique is the structured browser pass.

## Design health (shell + all surfaces, scored together)

| # | Heuristic | Score | Evidence |
|---|---|---|---|
| 1 | Visibility of system status | 4 | Selection and dates survive reload and are labelled in the context bar ("Last 30 days · Oct 26 – Nov 24"); failed site loads keep the bar with Retry; every report keeps its loading/empty/error state. |
| 2 | Match system / real world | 4 | Sign-in is a dedicated calm page with a validated return path; consent and form confirmation share the same public canvas. |
| 3 | User control and freedom | 4 | Sign-out exists at every width (monogram menu at 390); destructive actions keep inline confirmation; no disguised links remain. |
| 4 | Consistency and standards | 3 | One site selector on every page; single-column settings; remaining drift is the legacy plain `page-shell` density on /independent-audits (mitigated in polish) and C-owned control-width inconsistencies on the Forms Setup tab. |
| 5 | Error prevention | 4 | Unknown-outcome locks, inline confirms, read-only gating and held-mode messaging all still behave (unchanged by this work). |
| 6 | Recognition rather than recall | 4 | Context is remembered per account; timestamps render in the viewer zone with labels; the range label names the active window instead of raw dates only. |
| 7 | Flexibility and efficiency | 3 | Rolling presets plus a one-click Last 30 days shortcut; the Forms table sorts, filters and searches loaded rows with an explicit partial-data notice; no server-side search exists (stated, not hidden). |
| 8 | Aesthetic and minimalist design | 3 | The header pill, account panels and duplicate selectors are gone; the world stayed Operations Desk. Remaining noise is C-owned: two full-width rust buttons in the Forms Setup tab and narrow table columns wrapping mid-word at 390px. |
| 9 | Error recovery | 4 | Inline errors with retry and connection links are consistent across surfaces. |
| 10 | Help and documentation | 4 | Connections notes, Forms copy and CSV help text stay explicit about limits and UTC conventions. |

**Total: 37/40 — strong.** The two points below 4 are owned by C/D files
(recorded in polish.md as fix requests); B-owned files are clean.

## Per-surface notes (browser evidence)

- **Shell (desktop + 390):** context bar composition is fixed on every route;
  at 390 it forms the two-row grid (website full width; range + Last 30 days
  share row two) and the user menu stays visible as a monogram button. Fixed
  in polish: the nav strip clipped "Connections" at 390 (now wraps).
- **Overview:** date menu, shortcut pressed-state and range label behave as
  documented; the pill is gone.
- **Websites:** single column, selected FQDN as subtitle, danger section last.
- **Forms:** Responses tab is the ruled data table with local-time Received
  column, status text + dot, checkboxes and View/Actions; Setup tab keeps host
  verification, form editor and notifications.
- **Connections:** single column; subtitle updated; account column gone.
- **Independent audits:** read-only state renders saved evidence with local
  timestamps; page rhythm improved in polish; empty comparisons state added.
- **Sign-in:** 400px ruled panel on the ivory canvas, rust actions, zone-free
  copy; the sign-up toggle now uses rust, not the retired green.
- **OAuth consent:** signed-out state shows "Sign in to review" with the
  encoded consent path; the page now reads as one centered column with the
  "Hatch." wordmark.
