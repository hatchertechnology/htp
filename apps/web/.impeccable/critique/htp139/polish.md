# htp#139 — Stage B2 polish notes

Rendered polish pass over the integrated static artifact (Forms flags on,
eligible fixture site, read-only comparisons) at 1280×800 and 390×844, browser
zone America/New_York, zero page errors. Screenshots:
`/mnt/storage/worktrees/plans/htp139-evidence/polish/`. Mechanical detector:
`.impeccable/critique/htp139/detect.json`. Critique re-run:
`.impeccable/critique/htp139/critique-b2.md`.

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

## Findings — deferred to their owning part (fix requests, not B files)

- **C (`app/components/WebsiteForms.vue`, `FormsNotifications.vue`):** the
  "Create DNS challenge" and "Request verification" buttons render full
  panel width while sibling actions ("Save form", "Reload notification
  metadata") are compact — inconsistent control sizing on the Setup tab.
- **C (`app/components/FormsSubmissionsTable.vue`):** at 390px the Name and
  Email columns wrap mid-word ("Robi n Hatc her", "visit o r1@…"); give the
  text columns a min-width so the horizontal scroll (which works well,
  sticky first column) carries the wrapping instead.
- **C/D (detector advisories, `detect.json`):** ten `design-system-font-size`
  and two `design-system-color` advisories sit in `WebsiteForms.vue`,
  `FormsNotifications.vue`, `FormsSubmissionsTable.vue` and
  `pages/websites.vue`. The 11px/12px table sizes and the danger colors are
  documented in DESIGN.md prose (11px column headings, pale rust danger
  backgrounds); the 17px/19px steps match the documented "narrow report
  headers 19–21px" and settings subtitle uses. Advisories only; no B action.

## Verified and unchanged

- Range behaviour, selection persistence, sign-in return paths, public routes,
  Forms nav gating and the single site selector re-verified through
  `tests/fixtures/check-shell-static.mjs` after the polish edits (both
  viewports, both artifacts).
- No changes to Forms gate expressions, fetch builders or safety behaviour;
  no edits to C- or D-owned files in this pass.
