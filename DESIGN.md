# Helpdock design system — "Quiet desk"

Status: accepted · Version 1.0 (2026-09-18) · Owner: @Docker-Hunterpedia
Canvas with color, type, component sheet and reference screens: https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ (private until shared).

**Design-first rule.** Every screen is designed on that canvas before it is built. Artboards are named by area and screen, for example `Admin/Login`, `Admin/Wizard`, `Widget/Chat-AR`. An implementation PR names the artboard it was built from.

This document is the source of truth for how Helpdock looks and behaves visually across the admin app, the widget and the help center. Tokens here become `packages/ui/tokens.json`, the MUI theme, and the widget's CSS custom properties. When code and this file disagree, this file wins until it is changed by PR.

---

## 1. Principles

1. **A tool, not a landing page.** Agents live in the admin app for hours. Calm surfaces, dense but breathable rows, no decoration that does not carry information.
2. **One accent, four statuses.** Teal means "action" and "open". Green, amber, red and violet mean success, waiting, danger and escalation. A hue never carries two meanings.
3. **Arabic is a first-class script.** The type family was drawn for both scripts. Every layout is authored with logical properties so RTL is a flip, not a fork.
4. **Brands tint, they do not restyle.** A brand can change the accent, the surface tone, the radius, the logo and the launcher. Spacing, type scale, component anatomy and status colors are fixed, so every help center and widget still feels like Helpdock underneath.
5. **Accessible as drawn.** Every text and background pair listed here passes WCAG 2.1 AA. Real buttons, real inputs, visible focus, 44 px touch targets in the widget.

## 2. Color

### 2.1 Palettes

Warm neutrals for the ground and text. One teal ramp for actions.

| Neutral | Hex | Teal | Hex |
|---|---|---|---|
| n0 | `#FFFFFF` | teal50 | `#ECF7F5` |
| n50 | `#F7F5F0` | teal100 | `#CDEBE6` |
| n100 | `#EFECE5` | teal200 | `#9DD6CD` |
| n200 | `#E3DFD6` | teal300 | `#5FB8AC` |
| n300 | `#CFC9BD` | teal400 | `#2A968A` |
| n400 | `#A8A196` | **teal500** | **`#0F766E`** |
| n500 | `#7D7669` | teal600 | `#0C5F59` |
| n600 | `#5C564C` | teal700 | `#0A4A45` |
| n700 | `#403C35` | teal800 | `#083733` |
| n800 | `#2A2724` | teal900 | `#05231F` |
| n900 | `#16181C` | | |

Status hues, each with a solid, a tint for backgrounds, and a deep text color for use on the tint:

| Status | Solid | Tint | Text on tint | Meaning |
|---|---|---|---|---|
| success | `#2E7D4F` | `#E7F3EC` | `#1F5A38` | Done, within SLA, verified |
| warning | `#B45309` | `#FBEEDF` | `#7C3A06` | On hold, awaiting customer, SLA at risk, internal note |
| danger | `#B3261E` | `#FBE7E5` | `#8A1B15` | Urgent, SLA breached, destructive actions, errors |
| info | `#2B5FB3` | `#E6EEF9` | `#1E4483` | Medium priority, informational |
| escalated | `#6B4FBB` | `#EEEAF8` | `#46307F` | Escalated status only |

### 2.2 Semantic tokens

Components reference semantic tokens only, never palette values.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg.canvas` | n50 | `#15171B` | App background |
| `bg.surface` | n0 | `#1C1F24` | Cards, panels, list rows, inputs |
| `bg.muted` | n100 | `#23272E` | Selected nav item, table header, hover on rows |
| `bg.inverse` | n900 | n100 | Toasts, tooltips |
| `text.primary` | n900 | `#ECEBE6` | Body copy, headings |
| `text.secondary` | n600 | n400 | Metadata, captions, labels |
| `text.disabled` | n400 | n500 | Disabled controls |
| `text.inverse` | n0 | n900 | On inverse and on accent |
| `text.link` | teal500 | teal300 | Links |
| `border.default` | n200 | `#2E333B` | Dividers, cards |
| `border.strong` | n300 | `#3A404A` | Inputs, secondary buttons |
| `border.focus` | teal500 | teal300 | Focus ring |
| `action.primary` | teal500 | teal300 | Primary buttons, active tab, selected row edge |
| `action.primary.hover` | teal600 | teal200 | |
| `action.primary.active` | teal700 | teal100 | |
| `action.primary.text` | n0 | n900 | Text on primary |
| `action.primary.tint` | teal50 | `#123331` | Selected list row, AI surfaces |
| `status.<name>` | solid | solid lightened one step | Dots, borders, solid badges |
| `status.<name>.tint` | tint | 12 % of solid over `bg.surface` | Badge backgrounds |
| `status.<name>.text` | text on tint | solid | Badge text |

Contrast that was checked: `text.primary` on `bg.canvas` 15.9:1, `text.secondary` on `bg.canvas` 6.4:1, `action.primary.text` on `action.primary` 5.2:1, `text.link` on `bg.canvas` 4.8:1, each `status.text` on its tint ≥ 6:1. Dark values were chosen to keep the same minimums; verify them in `packages/ui` with a unit test that computes contrast for every pair in this table.

### 2.3 Rules

- Text on the teal accent is white in light mode. Never put teal text on a teal tint darker than teal100.
- Neutral 400 is the lightest grey allowed for text and only at 24 px or larger. Captions use neutral 600.
- Do not introduce new hues. A new meaning gets a shape or an icon, not a color.
- Charts use the palette in [dataviz conventions](#9-charts) and never the status hues for series.

## 3. Typography

| Role | Family | Weights |
|---|---|---|
| UI and content, Latin | IBM Plex Sans | 400, 500, 600 |
| UI and content, Arabic | IBM Plex Sans Arabic | 400, 500, 600 |
| Ticket ids, keys, code, timers | IBM Plex Mono | 400, 500 |

The two sans faces are one family drawn together, so mixed EN/AR lines share x-height, weight and rhythm. Fonts are self-hosted as woff2 from `packages/ui/fonts` and subset per script. The widget loads its fonts from the Helpdock origin, never from a third party. Fallback stack: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.

### 3.1 Scale

Line-heights are multiples of 4. Admin base is 14 px; widget and help center base is 16 px.

| Style | Size / line | Weight | Use |
|---|---|---|---|
| display | 32 / 40 | 600 | Help center article titles, empty states |
| h1 | 24 / 32 | 600 | Page titles in admin |
| h2 | 20 / 28 | 600 | Ticket subject, help center section headings |
| h3 | 16 / 24 | 600 | Panel headings, dialog titles |
| body-lg | 16 / 24 | 400 | Widget messages, help center body |
| body | 14 / 20 | 400 | Admin default |
| body-strong | 14 / 20 | 500 | Names, row titles, button labels |
| caption | 12 / 16 | 500 | Metadata, badges, form hints |
| mono | 13 / 20 | 400 | Ticket numbers, API keys, SLA timers, code |

### 3.2 Rules

- Three weights only. Bold (700) is not loaded.
- Arabic: same sizes and weights; `letter-spacing: 0`; no `text-transform: uppercase`; no italics. Section labels that are uppercase in Latin are rendered as regular-case caption-weight in Arabic.
- Numbers, ticket ids, emails and URLs inside Arabic text are wrapped in `<bdi>` or `dir="ltr"` spans so they render left-to-right.
- Paragraph max-width: 68 characters in the help center, 720 px in the ticket thread.
- `text-wrap: pretty` on headings and article paragraphs.

## 4. Spacing, radius, elevation, motion

**Spacing scale (px):** 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Component internals use 4 to 12. Layout gaps use 16 to 24. Section margins use 32 to 64. Never a value outside the scale.

**Radius:** `sm` 4 (menu items, inline chips) · `md` 6 (buttons, inputs, tags, badges, nav items) · `lg` 10 (cards, dialogs, message bubbles, composer) · `xl` 14 (widget window) · `full` 999 (pills, avatars, launcher, widget input). Brands may override `md` and `lg` within 0 to 12.

**Elevation:** borders do the work; shadows only lift overlays.

| Level | Light | Dark |
|---|---|---|
| 0 | `1px solid border.default` | same |
| 1 (composer, sticky bars) | `0 1px 2px rgba(22,24,28,0.06)` + border | border only, surface one step lighter |
| 2 (menus, toasts, launcher) | `0 4px 12px rgba(22,24,28,0.10)` + border | border + `bg.muted` |
| 3 (dialogs, widget window) | `0 12px 32px rgba(22,24,28,0.16)` + border | border + `bg.muted` |

**Motion:** 120 ms `ease-out` for hover, focus and toggles · 200 ms `ease-out` for panels, menus and toasts · 320 ms `cubic-bezier(0.2, 0, 0, 1)` for dialogs and the widget opening. Nothing loops except the typing indicator and skeletons. Everything honours `prefers-reduced-motion: reduce` by dropping to 0 ms.

**Focus:** `outline: 2px solid border.focus; outline-offset: 2px` on every interactive element, always visible on keyboard focus, never removed. Inputs also switch their border to `border.focus`.

## 5. Iconography

- One set everywhere: **Lucide**, 24 px grid, 2 px stroke, `currentColor`. Admin uses `lucide-react`; the widget inlines the subset it needs as SVG strings (no icon font, no runtime import) to stay under the size budget; the help center uses the same inlined subset.
- Sizes: 14 px inside badges and captions, 16 px in buttons and nav, 18 px in the widget composer, 24 px for the launcher and empty states.
- Icon-only buttons always have `aria-label`. Decorative icons have `aria-hidden="true"`.
- Directional icons (chevrons, send, back) are mirrored in RTL with `[dir="rtl"] & { transform: scaleX(-1) }`. Non-directional icons (search, paperclip, clock) are not mirrored.
- Channel icons: email = `mail`, widget = `message-circle`, Telegram = `send`, web form = `file-text`, API = `code`, manual = `pencil`. AI = `sparkles`. No emoji anywhere in the UI.

## 6. Components

Anatomy, sizes and states for the shared set in `packages/ui`. Every component ships with light and dark, LTR and RTL, and a Playwright screenshot test in both locales.

### 6.1 Controls

| Component | Sizes (height) | Variants | States |
|---|---|---|---|
| Button | sm 28 · md 36 · lg 44 (widget) | primary, secondary (outlined), ghost, danger (outlined red; solid red only in confirmation dialogs) | hover, active, focus, disabled, loading (spinner replaces icon, label stays) |
| IconButton | same as Button, square | secondary, ghost | same; `aria-label` required |
| Input, Textarea | md 36 · lg 44 | default, with leading icon, with trailing action | hover, focus, invalid (red border + 12 px hint), disabled, read-only |
| Select, Combobox | md 36 | single, multi (chips inside) | as Input; menu is elevation 2 |
| Checkbox, Radio, Switch | 16 px box · switch 20×36 | | checked, indeterminate, focus, disabled |
| SegmentedControl | md 32 | | used for Reply / Internal note |
| Search | md 32 (admin) · lg 40 (help center) | | shows `⌘K` hint in admin |

Labels sit above inputs, 13 px weight 500, 6 px gap. Hints and errors go below at 12 px. Required fields show a text "required" suffix in the label, not an asterisk.

### 6.2 Indicators

| Component | Anatomy |
|---|---|
| StatusBadge | 22 px pill, tint background, 6 px dot in the solid hue, caption text in `status.text`. One per system state plus custom statuses inherit their mapped state's hue. |
| PriorityBadge | 22 px, radius md. Low = neutral outline; Medium = info outline; High = warning outline; Urgent = solid danger with white text. |
| SlaTimer | 22 px, radius md, mono 12. Running = green clock icon, remaining time. At risk (< 20 % left) = warning. Breached = danger tint with "Breached 2h". Paused = neutral, "paused". |
| Tag | 22 px, radius md, 12 px weight 500. Color chosen from a fixed set of 8 tints (info, success, warning, escalated tints plus four neutral-warm tints); never the danger tint. Overflow collapses to "+n". |
| Avatar | 20 · 24 · 28 · 36 px circles, initials in weight 600. Staff use teal100/teal700; contacts use n200/n700; the assigned agent on a row uses solid teal with white. Unassigned = dashed n400 ring. Presence dot 8 px bottom-end. |
| ChannelIcon | 14 px Lucide icon + caption label in `text.secondary`. |
| PresenceDot | 8 px: online success, away warning, offline n400. |

### 6.3 Content

| Component | Anatomy |
|---|---|
| TicketRow | 56 px (list) or 64 px (side list). Checkbox · 8 px priority dot · title body-strong (ellipsis) + caption line (mono id, contact, department) · StatusBadge · SlaTimer or mono time · assignee Avatar 24. Selected row: `action.primary.tint` background and a 3 px `action.primary` inline-start edge. Hover: `bg.muted`. |
| MessageBubble | radius lg, body 14 (admin) or 15 (widget). Contact: `bg.surface` + border, aligned inline-start. Staff/public: `action.primary.tint` + teal100 border, aligned inline-end. Internal note: warning tint + 1 px dashed warning border, full width, "INTERNAL NOTE" caption in warning. AI: `bg.surface` + teal200 border, "AI" sparkles caption, citations as links. System event: centred caption between two 24 px hairlines. |
| Composer | elevation 1 card: SegmentedControl (Reply / Internal note) + recipient caption; optional AI suggestion strip (teal tint, "Insert" secondary button); textarea; toolbar with attach, canned response, translate, "then set status" select, primary Send. Internal note mode tints the whole card with warning tint. |
| DetailsPanel | 300 px, `bg.surface`, 20 px padding. Contact card, then labelled 32 px read-only fields, SLA card on `bg.canvas` with a 4 px progress bar, custom fields, linked tickets. |
| ArticleCard, ArticleSuggestion | radius md, border, book icon, title, chevron-end. |
| EmptyState | 24 px icon in n400, h3, one sentence, one primary or secondary action. Never an illustration. |
| Skeleton | n100 blocks, radius md, 1.2 s pulse; count matches the real rows. |

### 6.4 Overlays and feedback

| Component | Anatomy |
|---|---|
| Dialog | elevation 3, radius lg, 16–24 px padding, h3 title, body 13–14 in `text.secondary`, actions end-aligned: ghost Cancel then primary (or solid danger for destructive). Max width 480 (confirm) or 720 (forms). Focus trapped, `Esc` closes unless destructive-in-progress. |
| Drawer | 420 px from the inline-end side (so it opens from the left in RTL). Used for ticket quick view, rule editor test-run, knowledge source logs. |
| Menu | elevation 2, 6 px padding, 32 px items radius sm, hover `bg.muted`, danger items in danger text, 1 px dividers. |
| Tooltip | `bg.inverse`, caption text, radius sm, 200 ms delay. Never the only carrier of an icon's meaning. |
| Toast | `bg.inverse`, 13 px, icon in teal300 or status hue, optional inline action (Undo), auto-dismiss 6 s, pauses on hover, stacked bottom-inline-end. |
| Banner | full width, status tint + border, icon, text, dismiss. Used for budget alerts, reindexing, environment-locked settings. |

### 6.5 Navigation and layout (admin)

- **Shell:** 220 px sidebar on `bg.canvas` with brand switcher, primary nav (36 px items, icon + label + mono count), "Views" group (32 px items), current user at the bottom. Content area on `bg.canvas`; lists and panels on `bg.surface` separated by 1 px borders, not gaps.
- **Ticket workspace:** sidebar 220 · list 360 · thread flexible · details 300. Below 1280 px the details panel becomes a drawer; below 1024 px the list becomes a drawer too.
- **Tabs:** 32 px, 13 px weight 500, 2 px underline in `action.primary`.
- **Tables (settings, reports):** 44 px rows, header on `bg.muted`, mono for numbers, right-aligned numerals (start-aligned text), sticky header.
- **Page header:** h1 + optional caption, primary action at inline-end. No breadcrumbs in admin; the sidebar is the map.

### 6.6 Widget

- **Launcher:** 56 px circle in the brand accent, `message-circle` icon (or brand icon/text), elevation 2, bottom-inline-end 20 px (position per brand). Unread count as an 18 px danger dot with white numeral.
- **Window:** 380 × 640 max, radius xl, elevation 3; on phones it fills the viewport minus safe areas. Header in the brand accent with avatar, name, "usually replies in…" caption, minimise. Thread on `bg.canvas`. Suggestion strip and composer on `bg.surface`. "Powered by Helpdock" 11 px in n500 (removable per licence terms in the admin).
- **Bubbles:** visitor = accent with white text, radius 14/14/4/14 (the small corner toward the sender, mirrored in RTL); agent and AI = `bg.surface` + border. AI replies carry the sparkles caption and their citations; quick-reply chips are 36 px pills.
- **Composer:** 44 px pill input, attach and voice IconButtons at 44 px, 44 px round send in the accent. Voice recording replaces the input with a waveform bar, elapsed time in mono, cancel and stop.
- **Modes:** chat; chat + articles (suggestion strip appears while typing); help center (search field replaces the thread, results as ArticleCards); form (labelled fields, one primary Submit, success state with ticket number in mono).
- **Pre-chat form, queue position, offline notice, transcript request, CSAT (five 44 px buttons and a textarea)** all follow the same components.

### 6.7 Help center

- 1280 px container, 64 px side padding, 3-column article layout 240 / flexible / 240; single column below 1024 px with the section nav collapsing into a select.
- Header 64 px on `bg.surface`: logo + brand name, category nav, 320 px search, locale switch showing the other language's own name ("العربية" / "English").
- Article: breadcrumb 13 px, display title, meta caption, body-lg with 68-character measure, tables as bordered cards, callouts in teal tint (tip) or warning tint (caution), code blocks in mono on `bg.muted`, feedback card at the end, "Still need help?" card in the end column opening the widget with article context.
- Home: search hero on `bg.canvas` (display heading, 48 px search), category cards (radius lg, icon, title, article count), featured and popular lists.
- SEO output is plain semantic HTML; no component depends on JavaScript to be readable.

## 7. Right-to-left

- All layout uses logical properties: `margin-inline-start`, `padding-inline-end`, `inset-inline-end`, `border-inline-start`, `text-align: start`. Physical `left`/`right` are banned by a Biome rule in `packages/ui`, `apps/admin`, `apps/widget`, `apps/helpcenter`.
- `dir` is set on `<html>` from the locale; MUI runs with `stylis-plugin-rtl` and an RTL cache when `dir="rtl"`. The widget sets `dir` on its Shadow DOM host.
- Mirror: chevrons, arrows, send, back, progress direction, message bubble corners, drawer side, launcher position, toast stack position. Do not mirror: search, clock, paperclip, checkmarks, brand logos, numerals, code.
- Mixed-direction text: ticket ids, emails, URLs, phone numbers and code in `<bdi>`. Timers and counts are Latin digits in both locales (Arabic-Indic digits are a v1.1 setting).
- Line-height for Arabic body text is the same 24 px at 16 px size; IBM Plex Sans Arabic was checked not to clip at that leading.
- Screenshot tests run every component and every reference screen in `ar` and diff against the `en` baseline mirrored, to catch a physical-property leak.

## 8. Brand theming

What a brand can set (Team Leader, admin "Widget" and "Help center" pages, live preview):

| Token | Default | Constraint |
|---|---|---|
| `brand.accent` | teal500 | Any hex. Hover and active are derived in OKLCH by −0.06 and −0.12 L. `action.primary.text` is computed: white if contrast ≥ 4.5:1, else n900. The tint is the accent at 10 % over `bg.surface`. The admin shows the computed contrast and blocks values below 3:1 against the surface. |
| `brand.surfaceTone` | warm (`n50` ground) | `warm` · `neutral` (`#F5F5F4`) · `cool` (`#F4F6F8`). Picks one of three pre-built neutral ramps; text and border tokens follow the ramp. |
| `brand.radius` | 6 | 0–12; scales `md` and `lg` proportionally, `full` unchanged. |
| `brand.font` | IBM Plex Sans | One of a curated list of self-hosted pairs with an Arabic companion (IBM Plex, Noto Sans, Vazirmatn + system). No arbitrary font URLs. |
| `brand.mode` | auto | `light` · `dark` · `auto`. |
| `brand.logo`, `brand.favicon` | none | Uploaded, re-encoded, max 512 px. |
| `brand.launcher` | icon | `icon` · `icon+text` · `text`; label per locale; position `inline-end` or `inline-start`. |
| Help center `brand.customCss` | none | Sanitised: no `@import`, no `url()` outside the brand's own uploads, no `position: fixed` overlays. Applied after tokens so it can override, but the a11y check still runs on the rendered page. |

Status hues, spacing, type scale and component anatomy are **not** brand-configurable.

## 9. Charts

Reports use a categorical palette derived from the system, in this order: teal500, info, `#8A6D3B` (warm ochre), escalated, `#3B7E8A` (slate teal), n500. Sequential scales run teal100 → teal700. Diverging scales run danger → n200 → success. Status hues appear on charts only when the series *is* that status (for example "breached" in an SLA chart). Grid lines n200, axis text caption in `text.secondary`, no 3-D, no gradients, tooltips as Tooltip.

## 10. Accessibility checklist

Every PR that touches UI ticks these in the description:

- [ ] Text contrast ≥ 4.5:1 (≥ 3:1 at 24 px+), including on tints and on the brand accent.
- [ ] Every interactive element is a real `button`, `a[href]`, `input`, `select` or `textarea`, reachable by Tab, with a visible focus ring.
- [ ] Icon-only controls have `aria-label`; decorative icons are `aria-hidden`.
- [ ] Widget touch targets ≥ 44 px; admin targets ≥ 28 px with ≥ 8 px between them.
- [ ] Chat threads use `aria-live="polite"`; toasts use `role="status"`; errors are announced with `aria-describedby`.
- [ ] Dialogs trap focus and return it on close; drawers and menus close on `Esc`.
- [ ] Works at 200 % zoom and at 320 px width (widget) without horizontal scroll.
- [ ] Verified in `en` and `ar`; nothing depends on color alone.
- [ ] `prefers-reduced-motion` and `prefers-color-scheme` respected.

## 11. Implementation map

| Where | What |
|---|---|
| `packages/ui/tokens.json` | The tables in §2–§4 as a single JSON object, the source for everything below. Includes the three neutral ramps for `brand.surfaceTone`. |
| `packages/ui/src/theme.ts` | Builds the MUI theme from tokens: palette, typography, shape, shadows, component overrides (`MuiButton`, `MuiOutlinedInput`, `MuiChip`, `MuiDialog`, `MuiTooltip`, `MuiSnackbar`, `MuiTab`, `MuiTableCell`), RTL cache. |
| `packages/ui/src/css.ts` | Emits the same tokens as CSS custom properties (`--hd-*`) for the widget and help center, with light and dark blocks under `prefers-color-scheme` and `[data-theme]`. |
| `packages/ui/src/components/*` | The React components in §6 for admin and help center. |
| `apps/widget/src/ui/*` | Preact equivalents of the widget subset only, styled with the `--hd-*` variables inside the Shadow DOM. |
| `packages/ui/src/brand.ts` | `resolveBrandTheme(brandTokens)`: derives hover/active/tint/text-on-accent, validates contrast, returns the final token set for a brand. Unit-tested against §8. |
| `packages/ui/fonts/` | Subset woff2 files for the three families; served by the api with long cache headers. |
| `packages/ui/src/__tests__/contrast.test.ts` | Asserts every pair in §2.2 and every status tint/text pair meets AA. |

## 12. Change log

| Date | Change |
|---|---|
| 2026-09-18 | 1.0. Direction "Quiet desk" chosen over "Editorial ink" and "Signal". Canvas published. |
