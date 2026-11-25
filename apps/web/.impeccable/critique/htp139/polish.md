# htp#139 — Stage B2 polish notes

Rendered polish pass over the integrated static artifact (Forms flags on,
eligible fixture site, read-only comparisons) at 1280×800 and 390×844, browser
zone America/New_York, zero page errors. Screenshots are **viewport-height
captures** (not full-page): a full-page shot paints a viewport-pinned sticky
rail only for the first viewport, which reads as a white gap below the rail
that does not exist in the live layout (verified by the reviewers' scrolled
probes and by the sticky-rail assertion in `check-shell-static.mjs`).
Screenshots: `/mnt/storage/worktrees/plans/htp139-evidence/polish/`.
Mechanical detector: `.impeccable/critique/htp139/detect.json`. Critique
re-run: `.impeccable/critique/htp139/critique-b2.md`.

## Findings — fixed by B in this pass

1. **Nav strip clipped "Connections" at 390px** (P1, `main.css`). The
   horizontal navigation did not wrap after the Forms item was added, so the
   fourth item ran past the viewport. Fixed: `.desk-nav` wraps with a 6px row
   gap and links take `min-width: 0` at ≤650px.
2. **Sign-up toggle used the retired green** (P2, `legacy.css`). The sign-in
   panel's "Create an account" link kept `#07674f` from the pre-Operations-Desk
   palette. Fixed: it now uses the action rust token.
3. **Public wordmark hid the "Hatch." period** (P2, `main.css`). The rail's
   `.brand-stop { display: none }` also hid the period on the public canvas,
   against the documented wordmark. Fixed: scoped the rule to `.desk-brand`.
4. **OAuth consent page scattered its content** (P2, `oauth/consent.vue` +
   `main.css`). The heading and the panel were separate grid items of the
   public canvas, leaving a large uneven gap and a centered heading over a
   left-aligned panel. Fixed: one centered 640px column containing both.
5. **Independent-audits page had no vertical rhythm** (P3,
   `pages/independent-audits.vue`). Global `p { margin: 0 }` left the
   paragraphs and section headings flush. Fixed with scoped spacing and an
   explicit empty state for the Saved comparisons list.

## Findings — reassigned to B after Part C retired (fixed in this pass)

- **Setup-tab button widths** (`app/components/WebsiteForms.vue`,
  `app/components/FormsNotifications.vue`): the "Create DNS challenge" and
  "Request verification" buttons rendered full panel width while sibling
  actions ("Save form", "Reload notification metadata") were compact. Fixed
  with a scoped `justify-self: start` for direct button children of the grid
  forms — scoped styles only; no logic, gate or fetch change, and every Forms
  gate expression stays byte-identical.
- **390px submissions-table column wrapping**
  (`app/components/FormsSubmissionsTable.vue`): the Name and Email columns
  wrapped mid-word ("Robi n Hatc her", "visit o r1@…"). Fixed in the ≤650px
  block with `table { min-width: 720px }`, a 150px floor on value cells, and
  `position: relative` on `.table-scroll` so the absolutely positioned
  sr-only column label clips inside the scroll box instead of widening the
  document. Scoped styles only; review follow-up verified
  `document.scrollingElement.scrollWidth = 390` on `/forms` at 390px in the
  real app (was 717).

## Findings — deferred (detector advisories, `detect.json`)

- **D (`pages/websites.vue`):** two `design-system-color` advisories — the
  danger-section outline `#e3c3b4` and copy `#943311`, which DESIGN.md prose
  documents as the pale rust danger treatment. Advisories only; no action.
- The remaining eight `design-system-font-size` advisories sit in the Forms
  components and `pages/websites.vue` (11px/12px table sizes and 17/19px
  steps), all matching documented DESIGN.md prose (11px column headings,
  narrow report headers 19–21px). Advisories only; no action.

## Verified and unchanged

- Range behaviour, selection persistence, sign-in return paths, public routes,
  Forms nav gating and the single site selector re-verified through
  `tests/fixtures/check-shell-static.mjs` after the polish edits (both
  viewports, both artifacts).
- No changes to Forms gate expressions, fetch builders or safety behaviour;
  the two reassigned C fixes touch scoped styles only.
- After the reassigned fixes: `npm test` 497/497, `typecheck` clean,
  `check-forms-page.mjs` and `check-forms-table.mjs` PASS at both viewports,
  the five existing static Forms fixtures and `fixture:forms:check` PASS,
  `build:static` + `static:smoke` green, and `check-shell-static.mjs` green on
  both artifacts. Evidence captures refreshed.
