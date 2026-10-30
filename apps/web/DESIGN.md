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

Operations Desk pairs a persistent navy navigation anchor with an ivory work surface and white, finely ruled reports. Rust marks active navigation, actions, and the traffic line. The result is calm, practical, and deliberately flat.

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

## Layout

A two-column shell gives the desktop rail 223px and lets the workspace consume the remaining width. Workspace gutters are 30px. The report header is 104px high; context controls keep website, dates, and connection visible above the page content.

Report panels use 12–16px gaps; settings tasks use 24px gaps and 20–28px internal padding. Settings place an account panel in a 340px secondary column. The dashboard's Search-first composition is documented separately in `.impeccable/surfaces/dashboard.md`.

At 1279px the rail becomes 190px, gutters become 22px, and report/settings columns tighten. At 960px navigation becomes a horizontal top strip and settings stack. At 650px gutters become 16px, navigation wraps, context controls form a compact grid, report panels stack, and summary measurements become a two-column grid. Date controls use a bounded fixed menu on narrow screens. Tables retain horizontal scrolling when needed.

## Elevation & Depth

The report system has no decorative shadows. Navy, ivory, white, and fine borders convey hierarchy. Date and daily-data popovers sit above reports using positioning and a border, rather than a cast shadow.

**The Flat Desk Rule.** Separate report surfaces with white fill and fine borders; do not add decorative panel shadows.

## Shapes

Controls and navigation have small corners (4px); white report surfaces use slightly softer corners (5px). The date menu uses 6px corners. Nuxt UI buttons and inputs inherit the configured 8px control radius. Circular monograms, status dots, chart points, and the device donut serve identity, status, or data.

## Components

### Navigation

White icon-and-label links sit in the navy rail. Rust fill identifies the active page; a lighter navy fill identifies hover. Desktop links have 12px by 15px padding and a 50px minimum height; the horizontal navigation reduces its type and spacing while retaining a 44px minimum height above the narrow breakpoint.

### Buttons and fields

Primary actions use the rust UI primary token. Secondary actions use neutral outline or ghost Nuxt UI variants; the report refresh control is a small slate icon-and-text action. Framework buttons and inputs retain their Nuxt UI variant styles. Native website/date controls use white fill, a fine border, and a 42px minimum height. Focus is a 2px rust outline offset by 4px; disabled buttons and selects reduce opacity to 0.6. Inputs retain a rust caret.

### Reports and totals

White report panels use fine borders and compact headers. Summary measurements pair a navy line icon with a label and prominent number. Ranked reports use quiet row rules and right-aligned numeric columns. Device shares use a donut with a text legend. Empty reports preserve the panel structure and explain the next action; unavailable totals display an em dash.

### Traffic chart

The traffic series uses a rounded rust stroke (2.5px), a low-opacity fill, dashed grid lines, and outlined data points. Metric selection updates both the line and its expandable Daily data table. SVG descriptions and point titles support reading exact values without relying on color alone.

### Feedback and motion

Errors stay inline with retry or connection actions. Connection and account states include words beside status dots. Navigation and small links transition color over 160ms with `cubic-bezier(.16,1,.3,1)`; inherited button transitions use 160ms ease-out. A chart filter transition is declared at 180ms. A loading spinner rotates over one second. Reduced motion disables transitions and animations.

## Do's and Don'ts

### Do:

- Do retain navy navigation, ivory canvas, and white report surfaces.
- Do use the rust focus outline and visible labels for controls.
- Do preserve context and readable empty states while reports load.
- Do let long domains wrap or truncate deliberately and keep numeric columns aligned.

### Don't:

- Don't introduce gradients, glass, or decorative shadows into report panels.
- Don't replace actual report values or missing data with illustrative metrics.
- Don't add prior-period deltas unless the underlying comparison is available.
