---
name: Hatch Operations Desk
description: A website performance workspace with navy navigation, ivory canvas, and rust report accents.
colors:
  primary: "#b94d28"
  rail: "#182c3d"
  surface: "#ffffff"
  canvas: "#f6f5ef"
  text: "#10233a"
  muted: "#53677e"
  border: "#d9e1e7"
  nav-hover: "#2b4254"
typography:
  headline:
    fontFamily: "Encode Sans Variable, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontFamily: "Encode Sans Variable, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-.025em"
  body:
    fontFamily: "Encode Sans Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  metric:
    fontFamily: "Encode Sans Variable, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-.02em"
  label:
    fontFamily: "Encode Sans Variable, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "4px"
  panel: "5px"
  popover: "6px"
  framework-control: "8px"
spacing:
  compact: "12px"
  regular: "16px"
  panel: "20px"
  task: "24px"
components:
  context-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "0"
  user-menu:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
  data-table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  sign-in-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
  report-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "18px 20px 12px"
  navigation-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "12px 15px"
  select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  summary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "15px 20px"
---
# Design System: Hatch Operations Desk

## Overview

**Creative North Star: "Operations Desk"**

Operations Desk pairs a persistent navy navigation anchor with an ivory work surface and white, finely ruled reports. Rust marks active navigation, actions, and the traffic line. The result is calm, practical, and deliberately flat. The selected website and report dates are durable context that persists per account; every page reads them, so users never re-pick the subject of their work.

Self-hosted Encode Sans carries both headings and dense report text. Strong totals, tabular numerals, and restrained supporting labels establish hierarchy without ornamental imagery. Data, account, loading, and empty states use the same materials.

**Key Characteristics:**
- Navy navigation and ivory workspace
- White panels with fine rules and modest corners
- Rust for selection, actions, and chart emphasis
- Readable report hierarchy with tabular numerals

## Colors

The palette uses warm rust against cool navy and light paper neutrals. Frontmatter values are normative; color names below describe their application.

### Primary

- **Action Rust** (`primary`): active navigation, primary actions, focus outlines, text selection accents, and the traffic line. The chart area uses the same hue at 7% opacity.

### Neutral

- **Desk Navy** (`rail`): navigation and the first device-series color.
- **Ivory Canvas** (`canvas`): workspace, chart point fill, and inset property forms.
- **Report White** (`surface`): panels, inputs, and navigation text.
- **Report Ink** (`text`): headings, metrics, and main copy.
- **Slate Muted** (`muted`): control labels, chart labels, captions, and explanatory text.
- **Fine Rule** (`border`): panel boundaries, controls, and chart grid.
- **Navigation Hover** (`nav-hover`): hover feedback within the navy rail.

Connection status also uses green with a text label; error notices use a pale rust background and dark rust copy. Device categories have a small categorical palette, rather than repeating the traffic accent for every slice.

## Typography

**Display Font:** Encode Sans Variable, sans-serif fallback.
**Body Font:** Encode Sans Variable, sans-serif fallback.

The variable font is self-hosted through `@fontsource-variable/encode-sans`. Strong but compact headings share the same family as the report data.

- **Headline:** the overview title uses the frontmatter headline role; it becomes 30px at the narrow breakpoint.
- **Title:** main panel titles use the title role; lower reports use 23px and narrow report headers use 19–21px.
- **Body:** the body role sets the general reading rhythm. Settings descriptions stay around 65ch; centered report guidance stays around 46ch.
- **Metric:** summary totals use the metric role, reducing to 30px below 1280px and 27px below 651px.
- **Label:** controls use 13px; chart and table body labels use 12px, with 11px column headings and captions.

**The Readable Totals Rule.** Use tabular numerals for aligned measurements and retain explicit labels beside each total.

**Timestamps.** Timestamps display in the viewer's timezone with a short zone label (e.g. `Nov 24, 2026, 9:03 AM EST`); the UTC ISO value stays in `<time datetime>`/`title`. Calendar dates (report ranges, provider daily rows) are not shifted.

## Layout

A two-column shell gives the desktop rail 223px and lets the workspace consume the remaining width. Workspace gutters are 30px. The report header is 104px high; the context bar holds the website select and, on report pages, the date range and a Last 30 days shortcut. No status pills or account cards share that bar; account lives in the rail menu. The website select keeps the same position and left edge on every page.

Report panels use 12–16px gaps; settings tasks use 24px gaps and 20–28px internal padding. Settings pages use one column of ruled white sections, max ≈ 960px, with 24px gaps — no secondary account column anywhere. The dashboard's Search-first composition is documented separately in `.impeccable/surfaces/dashboard.md`.

Public pages (sign-in, OAuth consent, form confirmation) drop the rail: an ivory canvas, the "Hatch." wordmark top-left, and one centered white ruled panel — 400px for sign-in, up to 640px for wider consent and confirmation content — with 30px (16px narrow) gutters.

At 1279px the rail becomes 190px, gutters become 22px, and report/settings columns tighten. At 960px navigation becomes a horizontal top strip and settings stack; the user menu remains as a monogram button at the end of the strip. At 650px gutters become 16px, navigation wraps, the context bar forms a two-row grid (website full width; range and Last 30 days share row two), report panels stack, and summary measurements become a two-column grid. Date controls use a bounded fixed menu on narrow screens. Tables retain horizontal scrolling when needed.

## Elevation & Depth

The report system has no decorative shadows. Navy, ivory, white, and fine borders convey hierarchy. Date and daily-data popovers sit above reports using positioning and a border, rather than a cast shadow.

**The Flat Desk Rule.** Separate report surfaces with white fill and fine borders; do not add decorative panel shadows.

## Shapes

Controls and navigation have small corners (4px); white report surfaces use slightly softer corners (5px). The date menu uses 6px corners. Nuxt UI buttons and inputs inherit the configured 8px control radius. Circular monograms, status dots, chart points, and the device donut serve identity, status, or data.

## Components

### Navigation

White icon-and-label links sit in the navy rail — Overview, Websites, the gated Forms item, Connections. Rust fill identifies the active page; a lighter navy fill identifies hover. Desktop links have 12px by 15px padding and a 50px minimum height; the horizontal navigation reduces its type and spacing while retaining a 44px minimum height above the narrow breakpoint.

### Context bar

The header is the working context and nothing else: the labelled website select always, plus the date range control on routes that read report dates. No connection or account status appears here. A failed website load keeps the bar in place with a small Retry action beside the select.

### User menu

The rail ends with a user menu button: a circular monogram, the account email (truncated), and a chevron, opening a real dropdown — the email as a non-interactive label, a Connections item, and Sign out. Every part meets a 44px touch target; at 960px the email collapses and the monogram alone remains visible.

### Date range control

A labelled summary button opens a bounded menu: rolling presets (7/28/90), Start/End date fields, and an Apply action; a separate Last 30 days shortcut sits beside the menu with `aria-pressed` when the rolling preset is active. The summary names the window — "Last 30 days · Oct 26 – Nov 24" for a preset, "Custom · …" for a fixed range — so include-today is always visible as a labelled change. Range endpoints are calendar dates shown as stored; they are not timezone-shifted.

### Data table

Ruled white tables for dense rows (submissions, history). Column headings are 11px, sentence case, in Slate Muted; body text is 12px with tabular numerals for times and numbers; row rules use Fine Rule. Header cells that sort are buttons carrying `aria-sort`; status renders as text beside a small dot; the first column stays readable while narrower columns scroll horizontally at 650px; selection uses checkboxes with a "select visible" header. A notice row states partial data when more rows exist on the server.

### Tabs

Two-part surfaces (for example a form's Responses and Setup) use text tabs with a 2px rust underline for the active tab — no fill, no pills. Inactive tabs stay Slate Muted and meet a 44px target.

### Sign-in panel

The only sign-in surface: a 400px white ruled panel on the ivory public canvas, titled "Sign in to Hatch", holding the email/password form with the sign-up toggle and an "Authentication by Supabase" footnote. No rail, no workspace chrome.

### Danger section

Destructive settings (delete this website) are their own final section with a rust-tinted outline, plain-language consequence copy, and an inline confirmation step instead of a dialog.

### Buttons and fields

Primary actions use the rust UI primary token. Secondary actions use neutral outline or ghost Nuxt UI variants; the report refresh control is a small slate icon-and-text action. Framework buttons and inputs retain their Nuxt UI variant styles. Native website/date controls use white fill, a fine border, and a 42px minimum height. Focus is a 2px rust outline offset by 4px; disabled buttons and selects reduce opacity to 0.6. Inputs retain a rust caret.

### Reports and totals

White report panels use fine borders and compact headers. Summary measurements pair a navy line icon with a label and prominent number. Ranked reports use quiet row rules and right-aligned numeric columns. Device shares use a donut with a text legend. Empty reports preserve the panel structure and explain the next action; unavailable totals display an em dash.

### Traffic chart

The traffic series uses a rounded rust stroke (2.5px), a low-opacity fill, dashed grid lines, and outlined data points. Metric selection updates both the line and its expandable Daily data table. SVG descriptions and point titles support reading exact values without relying on color alone.

### Feedback and motion

Errors stay inline with retry or connection actions. Connection and submission states include words beside status dots. Navigation and small links transition color over 160ms with `cubic-bezier(.16,1,.3,1)`; inherited button transitions use 160ms ease-out. A chart filter transition is declared at 180ms. A loading spinner rotates over one second. Reduced motion disables transitions and animations.

## Do's and Don'ts

### Do:

- Do retain navy navigation, ivory canvas, and white report surfaces.
- Do keep the website select in the same position on every page.
- Do use the rust focus outline and visible labels for controls.
- Do preserve context and readable empty states while reports load.
- Do let long domains wrap or truncate deliberately and keep numeric columns aligned.

### Don't:

- Don't introduce gradients, glass, or decorative shadows into report panels.
- Don't replace actual report values or missing data with illustrative metrics.
- Don't add prior-period deltas unless the underlying comparison is available.
- Don't put status pills or account cards in the context bar or page body; account lives in the rail menu.
