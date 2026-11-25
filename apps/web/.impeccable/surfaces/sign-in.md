# Sign in to Hatch
Mode: Operate.
Approved direction: Operations Desk — context first (public layout extension).

## Direction contract
THESIS: A signed-out visitor reaches the workspace only through one calm,
obvious door; after signing in they land where they were going, not somewhere else.
OWN-WORLD: Existing ivory canvas, white ruled panel, self-hosted Encode Sans,
rust actions and focus rings. No new decorative materials, no rail.
STORY: The visitor arrives at `/sign-in?redirect=…` (the middleware's return
path), signs in or creates an account with the same form logic the app has
always used, and continues to the requested page. Failed attempts explain
themselves inline; confirmation-pending sign-ups are told to check their email.
FIRST VIEWPORT: The "Hatch." wordmark top-left, then one centered 400px white
ruled panel titled "Sign in to Hatch": email, password with a reveal toggle,
sign-in/sign-up toggle, primary rust action.
FORM: A local extension of Operations Desk on a public layout — no rail, no
workspace chrome, no illustrative metrics. Signature interaction: the return
path is honoured only after validation, so a crafted target can never redirect
off-origin.
FINISH: Reduced motion respected; every control labelled; 44px targets; the
"Authentication by Supabase" footnote stays.

## Finished implementation
`app/pages/sign-in.vue` renders `app/components/SignInForm.vue` inside the
public layout (`app/layouts/public.vue`). The OAuth consent page and the form
confirmation page share the same public layout. Signed-in visitors are sent
back to their validated `redirect` target (default `/`) by the route
middleware; signed-out visitors on protected routes are sent here with that
page as the return path.

## Review evidence
Checked against `app/pages/sign-in.vue`, `app/components/SignInForm.vue`,
`app/layouts/public.vue`, `app/assets/css/main.css` (public shell), DESIGN.md
and `.impeccable/design.json`. Browser evidence for the integrated artifact:
`tests/fixtures/check-shell-static.mjs` (both viewports) and the Stage B2
polish captures under `/mnt/storage/worktrees/plans/htp139-evidence/polish/`.
