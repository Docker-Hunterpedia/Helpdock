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
| `status.<name>` | solid | solid lifted by +0.20 OKLCH lightness | Dots, borders, solid badges |
| `status.<name>.tint` | tint | lifted solid at 12 % over `bg.surface` | Badge backgrounds |
| `status.<name>.text` | text on tint | the lifted solid | Badge text |

Contrast, as measured by the test in `packages/ui` (light / dark): `text.primary` on `bg.canvas` 16.3 / 15.0, `text.secondary` on `bg.canvas` 6.7 / 7.0, `action.primary.text` on `action.primary` 5.5 / 7.6, `text.link` on `bg.canvas` 5.0 / 7.6, every `status.text` on its tint ≥ 7.1 / ≥ 4.9. The +0.20 dark lift is the smallest round step that keeps every status pair above 4.5:1 (at +0.18 danger drops to 4.57). The test fails the build if any pair regresses.

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
- **Provider marks.** Lucide dropped brand icons in v1, and a second icon set is not allowed, so the Google and GitHub sign-in buttons carry their mark as an inline monochrome path in `currentColor` at 16 px (`apps/admin/src/ui/provider-marks.tsx`). They are decorative: the button's own label names the provider. No other brand mark is drawn anywhere.

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
| SecretField | md 36 | | A read-only password Input showing a fixed mask and an outlined "Replace" at its inline-end. A stored secret never reaches the browser, so Replace either opens the Input empty (a mailbox password) or, after a confirmation, shows the new value once in a Dialog with Copy (the inbound-parse secret). The hint says when it was saved and by whom (M2-08, `AdminEmailMailbox`, `AdminEmail`). |
| SegmentedControl | md 32 | | used for Reply / Internal note, People / Accounts, and the contact timeline filter. Unselected options use `text.secondary`, the selected one `action.primary` on `action.primary.tint` |
| Search | md 32 (admin) · lg 40 (help center) | | shows `⌘K` hint in admin |
| WeekHoursEditor | row 44 min | | one row per day, Sunday first (M3-01, `Admin/Ticketing-BusinessHours`): day name, a Switch with "Open"/"Closed" beside it, then the day's ranges as two md time Inputs (mono) with a ghost remove IconButton and, on the last range, a ghost add IconButton; a closed day reads "Closed all day" in `text.secondary`. A range that ends before it starts marks both inputs invalid and names the problem under the row in `status.danger`; every control is labelled with its day |
| PlaceholderPicker | list under a textarea | | the reply editor's placeholder list (M3-06, `AdminAutomationMacros`): a search input with `role="combobox"` controlling a `role="listbox"` of the allow-listed placeholders, grouped under caption headings, each a 32 px option with the mono `{{name}}` at inline-start and a sample in `text.secondary` at inline-end; the active one on `action.primary.tint`. ↑ ↓ move, Enter inserts at the caret, Esc closes and returns focus to the textarea. Elevation 2, radius md |
| StagedActions | sm 24 chips | | what an applied macro will do on send (M3-06, `AdminComposerMacros`): a labelled `role="group"` above the composer, a "Via macro …" caption, then one outlined radius md chip per action ("Status Open → Awaiting customer") on `bg.surface` with a 28 px remove IconButton that names the action it removes, and a clear button. No colour carries meaning |
| ToggleChip | sm 24 | outlined (off), filled `action.primary` (on) | a multi-select filter that is a row of named choices rather than a menu: the tags and the shared departments of a saved view (M1-05, `Admin/Ticketing-Views`). A real button with `aria-pressed` inside a labelled `role="group"`, so the state is announced and never carried by colour alone; disabled while the view's filters are fixed |
| RadioCard | min 64 | | a single choice that needs a sentence to explain it: the widget's mode and its out-of-hours behaviour (M4-06, `AdminWidget`). A `label` wrapping a real Radio, radius md, 12 px padding, 8 px gap: a 16 px Lucide icon and a body-strong title over a caption in `text.secondary`. Unchecked: `bg.surface` with a `border.strong` edge; checked: `action.primary.tint` with an `action.primary` edge. The group is a `fieldset` with a `legend` and `role="radiogroup"`; two columns from `md`, one below |
| ColorField | md 36 | | a brand colour (M4-06, the widget accent): a 36 px native colour picker with a `border.strong` edge beside a mono hex Input (`dir="ltr"`). The hint names the white-text contrast ratio the colour reaches; under 3:1 it becomes the error and Save refuses it, as the api does |

Labels sit above inputs, 13 px weight 500, 6 px gap. Hints and errors go below at 12 px. Required fields show a text "required" suffix in the label, not an asterisk.

### 6.2 Indicators

| Component | Anatomy |
|---|---|
| StatusBadge | 22 px pill, tint background, 6 px dot in the solid hue, caption text in `status.text`. One per system state plus custom statuses inherit their mapped state's hue. |
| PriorityBadge | 22 px, radius md. Low = neutral outline; Medium = info outline; High = warning outline; Urgent = solid danger with white text. |
| SlaTimer | 22 px, radius md, mono 12. Running = green clock icon, remaining time. At risk (< 20 % left, or an escalation step fired) = warning. Breached = danger tint with "Breached 2h", the time since the breach. Paused = neutral, "paused". Met = success with a check, "met". Reopened = the running state reading "next 2h". No policy draws nothing (M3-02, `Admin/Ticket-SLA`). Times are business time left, as the api judged them. |
| Tag | 22 px, radius md, 12 px weight 500, 1 px border in the matching hue. Color is one of eight keys: `info`, `success`, `warning`, `escalated` — the four status tints a tag may borrow — plus `sand`, `stone`, `clay` and `bark`, four steps of the warm neutral ramp (`bg.canvas`, `bg.muted`, `border.default`, `border.strong`). **Never the danger tint**: red means breached or destructive. Overflow collapses to "+n". |
| Avatar | 20 · 24 · 28 · 36 px circles, initials in weight 600. Staff use teal100/teal700; contacts use n200/n700; the assigned agent on a row uses solid teal with white. Unassigned = dashed n400 ring. Presence dot 8 px bottom-end. |
| ChannelIcon | 14 px Lucide icon + caption label in `text.secondary`. |
| PresenceDot | 8 px: online success, away warning, offline n400. |
| Label | A 12 px caption on `bg.muted` in `text.secondary`, radius md, no dot and no border: a fact about a row, not a status. "built-in" and "hidden" beside a view's name in Ticketing › Views (M1-05). Never a status colour, which would read as a StatusBadge. |
| StepProgress | One 4 px bar per step above a caption, as an `<ol>`. Done = solid `action.primary` with a check icon and the word "done"; current = the same hue at 50 % with the caption in weight 600 and `aria-current="step"`; later = `border.default` with the caption in `text.secondary`. A remaining count sits below. Used by the first-run wizard (`Admin/Wizard`); M7-10 appends a step to it. |
| PasswordStrengthBar | Four 4 px segments under a password field, filled to the reading in `status.danger` / `status.warning` / `status.info` / `status.success`. `aria-hidden`: the same judgement is named in the field's hint, which is what a screen reader reads. It is a hint and never a policy — the only rule the api enforces is the twelve-character floor. |
| HealthIndicator | An 8 px dot and the state in words beside it, never the colour alone: healthy `status.success`, behind `status.warning` with the label in `status.warning.text`, failing `status.danger` with the failure itself named ("IMAP sign-in failed") in `status.danger.text`, waiting the offline-presence neutral. A mono caption after it says when ("polled 12 s ago", "14:02"), and a failing row adds a 12 px "Fix" link to the form (M2-08, `AdminEmail`). |
| NotificationBell | M3-07, `AdminNotifications`. A 32 px square button, radius md, at the inline end of the sidebar's brand row; Lucide `Bell` 16. The unread count is an 18 px `full`-radius badge in `action.primary` with mono 11 px `action.primary.text`, at the top inline-end corner, capped at "99+". The badge is `aria-hidden` and the count is in the button's name ("Notifications, 3 unread"). Hover and open: `bg.muted`. |

### 6.3 Content

| Component | Anatomy |
|---|---|
| TicketRow | 56 px (list) or 64 px (side list). Checkbox · 8 px priority dot · title body-strong (ellipsis) + caption line (mono id, contact, department) · StatusBadge · SlaTimer or mono time · assignee Avatar 24. Selected row: `action.primary.tint` background and a 3 px `action.primary` inline-start edge. Hover: `bg.muted`. |
| MessageBubble | radius lg, body 14 (admin) or 15 (widget). Contact: `bg.surface` + border, aligned inline-start. Staff/public: `action.primary.tint` + teal100 border, aligned inline-end. Internal note: warning tint + 1 px dashed warning border, full width, "INTERNAL NOTE" caption in warning. AI: `bg.surface` + teal200 border, "AI" sparkles caption, citations as links. System event: centred caption between two 24 px hairlines. |
| Composer | elevation 1 card: SegmentedControl (Reply / Internal note) + recipient caption; optional AI suggestion strip (teal tint, "Insert" secondary button); textarea; toolbar with attach, canned response, translate, "then set status" select, primary Send. Internal note mode tints the whole card with warning tint. **Email mode** (M2-05, `AdminTicketEmail`), for a public reply on a ticket that answers by email: a "From" select replaces the recipient caption; a To / Cc grid of RecipientChips under the control row, the Cc line ending in a borderless "Add Cc" field; under the textarea, the signature as captions above a 1 px dashed hairline with "Signature · added when sent" and an Edit link; the primary reads "Send email". A note is unchanged. |
| RecipientChip | 24 px, radius md, `bg.muted` with a 1 px `border.default`: the name at 12/500, the address in `bdi` at 12 in `text.secondary`, and a 20 px ghost remove IconButton (`aria-label` "Remove …") when the recipient can be removed. The To line's contact has none. |
| DeliveryFailure | Under an outbound reply the mail server refused (M2-05): a full-width strip on `status.danger.tint` with a 1 px `status.danger` border, radius md, a 14 px alert icon, "**Not delivered** · error · after N attempts" at caption size in `status.danger.text`, and a text "Retry" button at its inline end. Drawn for a failed or discarded send only. |
| CustomerEmail | The customer email of `EmailCustomer` (M2-05, M2-06): one 600 px table with inline styles, the DESIGN token values written out because mail clients have no custom properties. Reply marker (12, `text.muted`, agent replies only), brand square 32 in the accent and name 16/600, body 16/24, signature 14/20 above a hairline, the automatic-reply note (12, auto-replies only), a reference box on `bg.canvas` with the mono `[HD-1042]` in `bdi`, footer 12. `dir` on the table; mirrored for Arabic. A plain-text part carries the same words. |
| EmailMessage | A customer's email in the thread (M2-04, M2-07, `AdminTicketEmail`): a 32 px contact avatar inline-start of a radius lg card on `bg.surface`. Header strip on `bg.canvas` with a 1 px `bg.muted` hairline: mail icon, sender body-strong 13, `<address>` and time at inline-end, then "To … · Cc …" caption. Body 14/20 as the sanitised HTML. Under it, when the mail pointed at remote images: a 32 px bar on `bg.canvas` with a border, image-off icon, "Remote images blocked · 2 from mail.acme.de" and a 24 px outlined "Load images"; loaded images replace the bar. Inline images as 180×72 figures on `bg.muted` (image icon, "name · inline" caption) beside the AttachmentChips. A 24 px outlined "Show quoted text" with `aria-expanded` reveals the quoted history with a 2 px `border.strong` inline-start edge. The threading-mismatch line is a System event with a link icon, "Referenced HD-1042 but sender is not a participant · time" and a second line "Open HD-1042 · Merge into HD-1042…", as a `role="note"`. |
| MergedThread | A merged ticket inside its primary's thread (M1-09, `AdminTicketDialogs` panel 7): an info-tint Banner naming the ticket, who merged it and when, with an outlined "Unmerge · 23 h left" button at its inline end while the 24 hours last; a caption between two flexible hairlines, "From HD-1042 · read only"; then its messages as radius lg cards on `bg.canvas` with a border, caption "author · time · mono reference", body 14. Not bubbles: nothing in it can be replied to. The merged ticket itself shows the same Banner the other way round above its thread, and no composer. |
| DetailsPanel | 300 px, `bg.surface`, 20 px padding. Contact card, then labelled 32 px read-only fields, SLA card on `bg.canvas` with a 4 px progress bar, custom fields, linked tickets. |
| SlaCard | The DetailsPanel's SLA card (M3-02, `Admin/Ticket-SLA`): radius md on `bg.canvas` with a border. Caption "SLA · policy"; one row per current clock (body name + caption "due Sun 10:00" / "was due 12:00" / "paused, no due time", and at the inline end a mono reading in the state's hue: "1h 20m left", "met in 1h 30m" with a check, "breached 2h 04m" with an alert icon, a pause icon when paused); a 4 px `role="progressbar"` for the unsatisfied clock due first, coloured by the ticket's state; one caption line for what happened last (step ran, escalated, paused since, reopened, closed). No policy: one body line, a caption naming the department and priority, and a link to Ticketing › SLAs for those who may change it. |
| ConditionRow | One condition of an SLA policy (M3-02, `Admin/Ticketing-SLAs`): the field, the operator ("is any of" / "is none of") and a multi Select with chips, then a ghost delete IconButton. |
| EscalationStep | One escalation step (M3-02): a 72 px mono percent Input with "%", the step's actions as removable outlined chips with a Lucide icon each, a ghost "Add action" that opens a Menu, and a ghost delete IconButton. The step at 100 % starts with a danger-tint "Breach recorded" chip that cannot be removed, and a caption that the breach is recorded whatever the step does. |
| TimeCard | In the DetailsPanel after the SLA card, only while the brand tracks time (M1-12). Radius lg card on `bg.surface`: "Time" body-strong + mono total; a timer strip on `action.primary.tint` (mono 18/24 clock with `role="timer"`, a 32 px outlined start/pause icon button, a small primary Log); entries as rows with 1 px `border.default` hairlines (mono duration 56 px, caption "who · note or how · when", 28 px delete icon); outlined "Add time manually". |
| SatisfactionCard | In the DetailsPanel after the TimeCard, once the ticket has a survey (M1-12). The SLA card's shape on `bg.canvas`: caption heading, one body line for the state, the comment as a quote with a 2 px `border.strong` inline-start edge, and an outlined "Copy survey link" while the link is usable. |
| CsatRating | The public rating page (M1-12): one 560 px card on `bg.canvas`, brand square and name, h1 question, mono reference · subject, five 64 px toggle buttons (`aria-pressed`, pressed = 2 px accent border on the accent tint), a textarea, a large primary Send, a caption footnote. Spent links show one warning notice and nothing about the ticket. |
| PreferenceMatrix | M3-07, Your account › Notifications. A radius-lg card holding a table (§6.5 Tables): a row header per event, body-strong label over a caption hint; one centred 16 px Checkbox per channel, each named "event, channel". A footer strip on `bg.canvas` with a caption and ghost Discard + primary Save, both disabled until something changed. A column the install cannot deliver is disabled, never hidden. |
| PushCard | M3-07, beside the PreferenceMatrix. Four states, one at a time: a radius-lg `bg.surface` card (heading with Lucide `Monitor`, an 8 px dot — `status.success` enabled, `text.disabled` not — the state in words, the device or the date) with "Turn on for this browser", or "Send a test" and "Turn off"; a warning-tint notice "Blocked by the browser"; and neutral `bg.muted` notices for "Not available in this browser" and "Not set up on this install". |
| ArticleCard, ArticleSuggestion | radius md, border, book icon, title, chevron-end. |
| RuleList | `Admin/Automation` (M3-03, `AdminAutomationRules`): an ordered list in a radius lg card on `bg.surface`, not a table, because its order is what it says. A 40 px header on `bg.muted` (caption 12/500, `aria-hidden`: the list's own name carries the meaning), then 60 px rows on a grid of drag handle · mono position · name body-strong over a one-line caption summary (ellipsis) · event or interval · mono last run and 30-day count, end-aligned · Switch · row menu, with `bg.muted` hairlines between. The handle is a button: drag, or ArrowUp / ArrowDown on it. A row whose rule the depth guard stopped today is tinted `status.warning.tint`, beside a warning Banner naming the loop. |
| RuleBuilder | The builder (M3-05, `AdminRuleBuilder`): When, If and Then as three radius lg cards on `bg.surface` with an h3 each. If holds condition groups as `fieldset`s (radius md, `border.default`), each a row of "Group n · match [any of \| all of] these conditions" and condition rows on a grid of field select · operator select · value editor · 28 px remove, `bg.muted` hairlines between; "and" / "or" in a caption between groups. The value editor follows the field: an input (`dir="auto"`), a select, the chosen values as 24 px radius md chips with a remove button plus an "Add…" select for "is any of", or an amount and a unit. Then is an `<ol>` of action rows: handle · mono number · action select · the action's own selects · remove; a canned reply adds a checkbox with the `counts_as_response` hint in caption. Selects are native `<select>`s in the outlined input. |
| TestRunPanel | The aside beside the builder (M3-05): radius lg card on `bg.surface`. h2, a caption that says nothing is changed, sent or logged; a search input for the sample ticket (invalid: `aria-invalid` and a danger caption with `role="alert"`); the ticket as a `bg.canvas` card (mono reference, subject, caption facts); the event select and an outlined "Run test". The result is a live region: a success- or warning-tint verdict box, then Conditions as a nested list with a 14 px check / cross / minus icon and a visually hidden "Matched: / Did not match: / Not needed:" before each, Would do as a numbered list with a caption per action, and Could set off. |
| ExecutionLog | The aside beside the rule list (M3-03): radius lg card, a header with h2, a result select and a search input, then entries as `<li>` with `bg.muted` hairlines: mono time, rule name body-strong, a 22 px pill (6 px dot + caption) in the result's tint — applied success, skipped `bg.muted`, stopped warning, failed danger — and a caption line starting with the ticket link. A stopped entry opens into a warning-tint box (radius md, `status.warning` border): the cycle or depth title in weight 600, the chain as a numbered list ending in a ban icon, the "kept" sentence, and links to the ticket and the rule. |
| AuditRow | A 44 px table row of the audit log (M3-08, `AdminAuditLog`): a 28 px expand IconButton (`aria-expanded`, `aria-controls`, chevron mirrored in RTL), mono time, actor (24 px avatar for staff, a Label for system, api key and visitor), mono action, target, brand, mono IP. Expanded, a full-width region on `bg.canvas`: a caption line (fields changed, request id, "via admin UI · Firefox on Ubuntu", target), then a Field · Before · After table whose values sit in mono on the danger and success tints, and a secret row that reads `[redacted]` with the caption "Secret: changed, value never recorded" |
| DomainRow | Brand › Domains (M5-07, `AdminBrandDomains`): one `<li>` per custom domain in a radius lg card, `bg.muted` hairlines between. A 52 px line: 8 px dot in the state's hue (verified success, waiting warning, failed danger), the mono hostname 14/500 in `bdi`, a "Primary" Label, the state in words in the matching `status.*.text` ("Verified · certificate issued 14 Sep", "Waiting for DNS · checked 2 min ago", "Certificate failed"), then at the inline end an outlined sm "Check now" (or "Try again") and the row Menu. Under a domain that is not serving: a danger Banner naming the failure and the last try, the DnsRecordTable while DNS is unverified, the "Proxied by Cloudflare" Checkbox with its hint, and a caption on DNS delay. A verified, serving domain is the line alone. |
| DnsRecordTable | Inside a DomainRow: a radius lg box on `bg.canvas` with a 13/500 caption, then a table on `bg.surface` (32 px header on `bg.muted`, 40 px rows): mono Type, Name and Value each with a 28 px outlined Copy IconButton that names what it copies, and "Seen by Helpdock" as a 14 px check or clock icon with "Found" (`status.success.text`) or "Not yet" (`status.warning.text`). Names and values are `dir="ltr"` in both languages. |
| OriginList | M4-03, `AdminWidget` Access card. A `ul` in a radius md box with a `border.default` edge: one 40 px row per origin: a 14 px Lucide `Globe`, the origin in mono 13 inside `bdi` (always LTR), and a small ghost remove IconButton named "Remove <origin>", `bg.muted` hairlines between. Under it an Input with an outlined "Add" button; Enter adds too. A malformed or repeated origin is refused in the Input's error line before it reaches the list |
| EmbedCode | M4-06, `AdminWidget`. A radius lg card whose aside holds an outlined "Copy" with Lucide `Copy`; the snippet is a focusable `pre` on `bg.muted`, radius md, mono 13/20, `dir="ltr"`, scrolling inline rather than wrapping. A caption under it links the protocol guide for native apps. Copying confirms with a Toast |
| WidgetPreview | M4-06, beside the Widget tab's cards (sticky from `xl`). A radius lg `aside` on `bg.surface` holding a scaled mock of §6.6's window and launcher, drawn with the widget's tokens (not the admin's) in the chosen accent, mode and position, so it shows what a visitor sees. Two small SegmentedControls switch it between light and dark and between English and Arabic; it opens in the admin's own language and mirrors in Arabic. Decorative contents are `aria-hidden`; the heading and toggles are not |
| EmptyState | 24 px icon in n400, h3, one sentence, one primary or secondary action. Never an illustration. |
| Skeleton | n100 blocks, radius md, 1.2 s pulse; count matches the real rows. |

### 6.4 Overlays and feedback

| Component | Anatomy |
|---|---|
| Dialog | elevation 3, radius lg, 16–24 px padding, h3 title, body 13–14 in `text.secondary`, actions end-aligned: ghost Cancel then primary (or solid danger for destructive). Max width 480 (confirm) or 720 (forms). Focus trapped, `Esc` closes unless destructive-in-progress. An irreversible action on a named thing (erasing a contact) asks for the name to be typed and keeps the danger button disabled until it matches exactly. |
| MacroPicker | elevation 3, radius lg, over the thread above the composer (M3-06, `AdminComposerMacros`), never taller than what is left of the viewport. A search combobox and the All / Macros / Canned toggle buttons (`aria-pressed`); a listbox of results beside a preview of the selected item filled in for the ticket, placeholder runs in `<mark>` on `status.warning.tint`, a language line with a "Use English / Use Arabic" text button, and "When you send the reply" as a list; footer with the key hint caption, ghost Cancel and primary Apply. `role="dialog"` with an `aria-label`; Esc closes |
| Drawer | 420 px from the inline-end side (so it opens from the left in RTL). Used for ticket quick view, rule editor test-run, knowledge source logs. |
| Menu | elevation 2, 6 px padding, 32 px items radius sm, hover `bg.muted`, danger items in danger text, 1 px dividers. |
| Tooltip | `bg.inverse`, caption text, radius sm, 200 ms delay. Never the only carrier of an icon's meaning. |
| Toast | `bg.inverse`, 13 px, icon in teal300 or status hue, optional inline action (Undo) in `text.inverse`, underlined; auto-dismiss 6 s, or 10 s when it carries an action; pauses on hover, stacked bottom-inline-end. |
| Banner | full width, status tint + border, icon, text, dismiss. Used for budget alerts, reindexing, environment-locked settings. Danger and info are `role="alert"`; the warning tone (M3-03, a loop the depth guard stopped today) is a standing state and `role="status"`. |
| ErrorSummary | M4-09, `WebFormEN`/`WebFormAR`. A danger Banner at the top of a form after a failed send: alert icon, "N fields need attention" in weight 600, then one underlined link per field in `status.danger.text`, each to its control. `role="alert"`, `tabindex="-1"` and focused on arrival; each field below it keeps its own invalid border and a 12 px error line tied by `aria-describedby`. |
| NotificationPanel | M3-07, `AdminNotifications` panel 1. A 400 px popover `role="dialog"` opening from the bell to the inline end, elevation 2, radius lg. Header: h2 16/24 · caption unread count · ghost "Mark all read" at inline end. SegmentedControl All / Unread. A list grouped under caption day headings (Today, Yesterday, Earlier); each row is a link: 28 px radius-md kind icon on a tint (danger breach, warning warning, escalated escalation, `action.primary.tint` mention, `bg.muted` assignment and reply), title body 14 (500 while unread), mono reference + one line, caption "where · when"; unread rows on `bg.canvas` with an 8 px `action.primary` dot whose meaning is visually hidden text. Footer: caption "Last 30 days" and a settings link. Empty: bell 24 in `text.disabled`, h3, one sentence, a link. |

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
- **Message states** (`Widget/States`, M4-04): *Sending* is a clock and the word under the bubble; *Sent* one check; *Seen* two checks after the read receipt; *Not sent* redraws the bubble on `bg.surface` with a `status.danger` border, the word in `status.danger.text` and a 44 px secondary Retry described by the bubble and the word, so no state is colour alone.
- **Strip** between the header and the thread, one at a time, most urgent first: Reconnecting (warning tint, `wifi-off`), Back online (success tint, 5 s), queue position (`bg.muted`, `users`), out of hours with the next opening in the brand's zone (`bg.muted`, `moon`), and the presence line (up to three 24 px avatars overlapping by 8 px, names joined by the locale's list format). Strips are `role="status"`; the presence line is not.
- **New-messages divider**: a hairline in `border.strong` either side of a caption ("2 new messages"), drawn before the first message a catch-up brought in.
- **Attachments in a bubble**: a 200 × 120 tile on `bg.muted` with the kind icon and file name for images and video (opens a short-lived URL); a file card on `bg.surface` with name, type and size and a 44 px download button; a voice note in the accent with a 44 px round play button, a decorative waveform and the duration in mono.
- **Suggestion strip and ArticleCard**: 44 px rows with `border.default`, a `book-open` or `file-text` icon, the title and a mirrored chevron. The article view inside the window uses the h2 style for its title, body-lg for the text and a footer link to the help center.
- **CAPTCHA box**: a `bg.canvas` panel with `border.strong` above the primary button; the provider draws inside it, and a status line says checking, verified (`status.success.text`) or failed (`status.danger.text`, `role="alert"`).

### 6.7 Help center

- 1280 px container, 64 px side padding, 3-column article layout 240 / flexible / 240; single column below 1024 px with the section nav collapsing into a select.
- Header 64 px on `bg.surface`: logo + brand name, category nav, 320 px search, locale switch showing the other language's own name ("العربية" / "English").
- Article: breadcrumb 13 px, display title, meta caption, body-lg with 68-character measure, tables as bordered cards, callouts in teal tint (tip) or warning tint (caution), code blocks in mono on `bg.muted`, feedback card at the end, "Still need help?" card in the end column opening the widget with article context.
- Home: search hero on `bg.canvas` (display heading, 48 px search), category cards (radius lg, icon, title, article count), featured and popular lists.
- SEO output is plain semantic HTML; no component depends on JavaScript to be readable.
- **Web form** (M4-09, `WebFormEN`/`WebFormAR`, at `/contact`): the help center header, then one form card (radius lg, `bg.surface`, 24/32 padding, at most 720 px): h1 and a `text.secondary` intro, the ErrorSummary when a send failed, a two-column grid of lg Inputs (one column below 720 px; long text, multi-select and checkbox fields span both), the attachments control (the browser's file input with its button drawn as an outlined lg Button, and a caption of counts, sizes and types), then the CAPTCHA box at inline-start and a lg primary Send at inline-end. Labels carry a "required" or "(optional)" suffix. The success state replaces the form with a success Banner (`role="status"`), an h1 with the mono reference in `<bdi>`, the brand's thank-you message and links on. No script of its own (ADR 0013).

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
| `brand.accent` | teal500 | Any hex. Hover and active are derived in OKLCH by −0.06 and −0.12 L. In dark mode the accent is first lifted by +0.21 L (the teal500 → teal300 step) so a mid-tone accent stays readable on the dark surface. `action.primary.text` is computed: white if contrast ≥ 4.5:1, else n900. The tint is the accent at 10 % over `bg.surface`. The admin shows the computed contrast and blocks values below 3:1 against the surface. |
| `brand.surfaceTone` | warm (`n50` ground) | `warm` · `neutral` (`#F5F5F4`) · `cool` (`#F4F6F8`). Picks one of three neutral ramps. The `neutral` and `cool` ramps keep the warm ramp's OKLCH lightness per step, take the ground's hue, and scale chroma by the ratio of the grounds' chroma; `n0` stays white and `n50` is the exact ground. Applies to light mode only; the dark neutrals in §2.2 are drawn values and do not change with the tone. Text and border tokens follow the ramp. |
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
| `packages/ui/src/theme.ts` | Builds the MUI theme from tokens: palette, typography, shape, shadows, component overrides (`MuiButton`, `MuiOutlinedInput`, `MuiChip`, `MuiDialog`, `MuiTooltip`, `MuiSnackbar`, `MuiTab`, `MuiToggleButton`, `MuiTableCell`), RTL cache. |
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
| 2026-09-19 | 1.1. Made three rules concrete after implementing `packages/ui`: dark status lift +0.20 L, dark brand accent lift +0.21 L, derivation of the `neutral` and `cool` ramps. Contrast figures replaced by the measured ones. |
| 2026-09-19 | 1.2. Gave SegmentedControl its own theme override (M1-04): MUI's default unselected colour is a translucent black that fails §10 on the canvas. |
| 2026-09-19 | 1.2. Added the §5 rule for OAuth provider marks after building the admin shell: Lucide v1 has no brand icons, so the two are inlined rather than adding a second icon set. |
| 2026-09-19 | 1.3. Added StepProgress to §6.2 for the first-run wizard (`Admin/Wizard`), and PasswordStrengthBar for the bar M0-06 built and the wizard reuses. A step that is merely later uses `text.secondary`, not `text.disabled`: the latter is 2.3:1 on the canvas, which §10 does not allow for a label anyone is meant to read. |
| 2026-09-20 | 1.4. Named the eight tag tints in §6.2 (M1-06). The four neutral ones are steps of the warm ramp rather than new values, so a brand's `surfaceTone` moves them and dark mode needs no second table; each tag also gets a 1 px border, because `sand` on a white card is otherwise invisible. |
| 2026-09-24 | 1.5. A Toast that carries an action (the Undo after a contact merge, M1-13) stays 10 s rather than 6, as the `After a merge` artboard says, and draws the action in `text.inverse`, underlined: there is no teal token that holds its contrast on `bg.inverse` in both themes. |
| 2026-09-24 | 1.6. Added MergedThread to §6.3 for merge and split (M1-09). It is built from the Banner, the hairline caption of the system event and the `bg.canvas` card, so it adds no token. |
| 2026-09-25 | 1.7. Added ToggleChip to §6.1 and Label to §6.2 for saved views (M1-05). Both are built from existing tokens (`action.primary`, `bg.muted`, `text.secondary`), so nothing new is added to the palette. |
| 2026-09-27 | 1.8. Added WeekHoursEditor to §6.1 and SlaCard, ConditionRow and EscalationStep to §6.3 for business hours and SLAs (M3-01, M3-02), and gave SlaTimer its met and reopened states. All are built from existing tokens and components. |
| 2026-09-27 | 1.9. Added RuleList, RuleBuilder, TestRunPanel and ExecutionLog to §6.3 for `Admin/Automation` (M3-03 to M3-05), and a warning tone to the Banner. All are built from existing tokens; the artboards' 10 px row gaps are drawn at 8, the nearest step of §4. The Switch of §6.1 is built for the first time here (`apps/admin/src/ui/switch.tsx`). |
| 2026-09-27 | 1.10. Added PlaceholderPicker and StagedActions to §6.1, AuditRow to §6.3 and MacroPicker to §6.4 for macros (M3-06) and the audit log (M3-08); all built from existing tokens. The Input override now lets a multiline input grow (`height: auto`): the fixed 36 px was clipping every textarea's rows. |
| 2026-09-27 | 1.11. Added NotificationBell (§6.2), NotificationPanel (§6.4), PreferenceMatrix and PushCard (§6.3) for staff notifications (M3-07, `AdminNotifications`). All are built from existing tokens; the kind icons borrow the status tints, so a breach reads as danger and a warning as warning without a new colour. |
| 2026-09-27 | 1.12. Added the widget's message states, strips, new-messages divider, attachment bubbles, suggestion strip, ArticleCard and CAPTCHA box to §6.6 (M4-01, M4-04 to M4-08, `Widget/States`, `Widget/Modes`). All are built from existing tokens. The boards' 15 px body, 13 px labels and 6, 10 and 14 px gaps are drawn at the §3–§4 steps (16, 14; 4, 8, 12 and 16). The header avatar sits on `action.primary.active` rather than a translucent white, which failed §10 behind two-letter initials. |
| 2026-09-27 | 1.13. Added RadioCard and ColorField to §6.1 and OriginList, EmbedCode and WidgetPreview to §6.3 for Channels › Widget (M4-03, M4-06 to M4-08, `AdminWidget`). All are built from existing tokens; the artboard's 10 px gap inside a RadioCard is drawn at 8, the nearest step of §4. Channels is now visible to Team Leaders, who see the Widget tab's appearance, conversation and content-policy cards; access and signed identity stay Admin only and say so with a Label. |
| 2026-09-27 | 1.14. Added ErrorSummary to §6.4 and the Web form to §6.7 for the hosted form (M4-09). Both are built from the Banner, the Input and the Button, so nothing new is added to the tokens. The artboard's file chips need client script and the page has none (ADR 0013), so the attachments control is the browser's own file input, styled. |
