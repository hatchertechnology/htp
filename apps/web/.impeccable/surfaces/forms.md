# Forms
Mode: Operate.

Approved direction: Operations Desk — context first. The selected website is the
subject of the page and comes from the persistent header context. The Forms page
is an inbox first; setup is secondary.

## Direction contract
THESIS: Make daily response triage the first job on `/forms`, while keeping form
management close enough to switch without losing the website context.
OWN-WORLD: Existing navy rail, ivory workspace, rust actions, flat ruled white
panels and self-hosted Encode Sans. No new colors, shadows or decorative assets.
STORY: Choose a website in the header, choose a form in a compact selector row,
then sort, filter, search, inspect, export or update loaded responses. Setup holds
host verification, form editing, the accept-submissions switch, the submission
endpoint and notifications when the build enables them.
FIRST VIEWPORT: Page heading “Forms” with the selected FQDN; form selector with
Active/Paused text; Responses and Setup tabs (Responses default); a ruled data
table with Received, Status, form-field columns, row actions and a View
disclosure. Filters and search sit above the table.
FORM: Local extension of the Operations Desk surface; no concept seed required.
Signature interaction: a form selection immediately opens its loaded responses;
the table's From/To inputs read local calendar days and convert to UTC instants.
FINISH: Finish review separates setup from triage, labels partial data and keeps
every gate, unknown-outcome lock and bounded read intact.

## Components
- **Tabs:** rust 2px underline on the active tab, no fill; 44px targets.
- **Data table:** 11px Slate Muted sortable headings with `aria-sort`, 12px body,
  tabular numerals for received times, Fine Rule row rules, status as text plus a
  small dot, selection checkboxes, a partial-data notice row and horizontal
  scrolling. At 650px the selection and time columns stay sticky.
- **View disclosure:** all response values as a `<dl>` with multiline text
  preserved; legacy delivery rows remain inside the same disclosure.
- **Bulk bar:** status actions only (Mark reviewed, Mark spam, Mark new when
  allowed), at most 100 selected visible rows, sequential and stopping on the
  first refusal or unknown outcome. No bulk delete.
- **Local time:** received, notification and host-verified instants display with
  a short zone label; the UTC ISO value stays in `<time datetime>` and `title`.
  The CSV export keeps UTC ISO values; its help text says so.

## Safety and states
Every response value renders through interpolation only; no `v-html` and no value
in `href`, `src` or `style`. CSV cells go through `csvCell`, which prefixes a
formula after leading whitespace. Forms flags keep their existing gate
expressions; the pilot eligibility read fails closed. Held builds show “Forms are
not available in this workspace yet.” and make no Forms requests. A pilot denial
shows “Forms aren't enabled for {fqdn}. The Forms pilot is limited to approved
websites.” Sorting, filters and search only touch loaded rows, and the table says
so when more responses exist.

## Responsive expression and motion
Desktop keeps the form selector and tabs in one row and the table full width.
At 650px filters and search stack, form choices fill the row, tabs divide the
width and the table scrolls horizontally with sticky selection/time columns.
Existing 160ms color transitions and reduced-motion rules are inherited.
