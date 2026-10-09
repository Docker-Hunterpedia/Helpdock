# Accessibility audit: widget and help center

Status: automated, keyboard, zoom, forced-colours, screen-reader-markup and mixed-direction passes done; the screen-reader pass itself is outstanding
Audited: 2026-10-05; extended 2026-10-09
Deliverable: M9-04 ([PRD §4 · M9](../planning/PRD.md#m9-hardening-and-10)), against
[REQUIREMENTS §5.4](../planning/REQUIREMENTS.md) (WCAG 2.1 AA on the widget and
help center) and the [DESIGN §10](../../DESIGN.md#10-accessibility-checklist)
checklist.

This page records what was checked, with which tools, what was found and fixed,
and what still needs a person. The checks are Playwright specs, so CI repeats
them on every pull request. This is not a one-off report.

## Tools

| Tool | Version | Used for |
|---|---|---|
| axe-core | 4.13.0 | Rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. Axe walks the widget's open shadow root. |
| @axe-core/playwright | 4.13.0 | Runs axe in the page |
| @playwright/test | 1.63.0 | Keyboard-only passes, emulated `prefers-color-scheme` and `prefers-reduced-motion` |
| Chromium | the build Playwright 1.63 installs in CI; Chromium 141 headless shell for the local run of this audit | The browser |

Forced colours are Chromium's emulation (`forcedColors: 'active'`), which is the
mechanism Windows High Contrast uses, not a Windows theme. Zoom is emulated by
the viewport's size in CSS pixels, which is what browser zoom changes.

Every spec runs with `reducedMotion: 'reduce'`. A panel caught mid-transition
can read as low contrast to axe, so the audit measures the settled state.
Motion itself is checked by the `prefers-reduced-motion` rules in each
stylesheet.

## What was checked

### Widget

The widget runs on its harness page (`apps/widget/harness/`) with the mock
transport. The spec is `apps/widget/e2e/a11y-audit.spec.ts`. It covers every
state below in `en` and `ar`, in the light and the dark scheme, so each state
is audited 4 times:

| Mode | States run through axe |
|---|---|
| Launcher | closed; closed with an unread count |
| Chat | empty thread; a message Sent then Seen; Reconnecting; Back online with the new-messages divider; voice recording; a voice note sent; the ended state with the transcript request |
| Chat, pre-chat | the form; its errors; queued with a position; an agent assigned and typing |
| Chat, availability | out of hours with the next opening; open with nobody online; a refused attachment |
| Chat + articles | the suggestion strip; an article opened from it |
| Help center | popular articles; results; nothing found; an article; an article that failed to load |
| Contact form | empty; its errors; the reference number after sending |

`widget.spec.ts` and `help-center.spec.ts` run axe on the same flows in light,
including the send that fails and its Retry. `widget.spec.ts` › "dark theme…"
also checks that a 320 px phone screen has no horizontal scroll.

Keyboard passes, in both languages:

- **Tab order and focus rings, beside a page.** From the message field, Tab
  goes to the voice button, Send, then the launcher (now "Minimise"), then out
  to the host page. It comes back in at Minimise, the thread and Attach. Every
  stop in the widget draws a 2 px focus ring. The window is a non-modal region,
  so Tab is allowed to leave it.
- **Focus trap on a phone.** At 320 px the window fills the screen. It is a
  modal dialog (`role="dialog"`, `aria-modal="true"`), Tab and Shift+Tab wrap
  inside it, and the launcher is hidden.
- **Escape** closes the window in chat, help center and form modes and puts
  focus back on the launcher.

### Help center

The pages the api renders run on the database-free e2e server
(`apps/api/e2e/help-center-server.ts`). The spec is
`apps/api/e2e/help-center-a11y.spec.ts`. It runs once per language (the `en`
and `ar` projects) and once per scheme:

| Page type | Status |
|---|---|
| Home | 200 |
| Category | 200 |
| Section | 200 |
| Article, with its video, callouts, table and code | 200 |
| Article, "What was missing?" step | 200 |
| Article, thanks | 200 |
| Article shown in the default language with the fallback notice (Arabic only) | 200 |
| Search, nothing asked; with results; nothing found | 200 |
| Not found | 404 |
| Archived article | 410 |
| Internal-only wall (a second server instance switched to internal-only) | 401 |

Keyboard passes, in both languages:

- **Skip link.** The first Tab stop is "Skip to content". It is visible when
  focused and is 44 px tall. Enter moves focus to `<main>`, and the next Tab
  reaches the first link in the content.
- **Focus rings.** On an article page, which has the most controls, 30 Tab
  stops each draw a ring of at least 2 px, on the element itself or on its
  field (the search box), and none of them is hidden.
- **"Was this helpful?"** works with the keyboard alone: No, then the note,
  Skip, then Send, then the thanks. The spec also checks that Skip sends
  nothing.

The CSAT page (`apps/admin/e2e/csat.spec.ts`) and the hosted web form
(`apps/api/e2e/web-form.spec.ts`) are also customer-facing. Their specs run
axe in light only.

### Beyond axe: zoom, forced colours, screen-reader markup, mixed direction

Axe cannot see these, so they are Playwright specs of their own, each run in
`en` and `ar`. The page types are the same as above. Reflow, markup and
direction do not depend on the colour scheme, so those specs run in light; the
forced-colours specs run in both schemes because the system palette follows the
scheme.

| Spec | Runs | What it proves |
|---|---|---|
| `apps/widget/e2e/a11y-reflow.spec.ts` | `en`, `ar`; 6 tests each | At 640 × 400 CSS px (200 % zoom of 1280 × 800), in the launcher, the thread, every strip, a failed send with Retry, the assistant answer, the voice recorder, the ended state, the rating card, the pre-chat form, the queue strip, the contact form with its errors, and the help center mode with a search and an article: the page does not scroll sideways, every control can be scrolled to, lies inside the viewport and is the element under its own centre, and no heading, button, label or strip cuts its text off. The widget at 320 px is the phone layout, which `widget.spec.ts` and `a11y-audit.spec.ts` cover. |
| `apps/widget/e2e/a11y-forced-colors.spec.ts` | `en`, `ar` × light, dark; 10 tests each | With forced colours on: Tab goes all the way round the chat window, the rating card, the pre-chat form, the contact form and the help center mode; every tabbable element gets focus and draws an outline of at least 2 px. The pressed rating differs from the others by border width, with `aria-pressed` saying so. The thumbs of "Was this helpful?" keep a drawn border. Every icon beside Sending, Sent, Seen, Not sent and each strip is displayed, at least 8 px, `stroke="currentColor"`, and its computed stroke is the text colour. |
| `apps/widget/e2e/a11y-semantics.spec.ts` | `en`, `ar`; 7 tests each | The thread is one `role="log"` with `aria-live="polite"` and has no live region inside or around it, through a message, Sent and Seen, an assistant answer, its thanks, the handoff line, the new-messages divider and every state of the rating card. One strip at a time is a `role="status"` (out of hours, queue position, Reconnecting, Back online give way to each other; the pre-chat form has none). On a phone the window is `role="dialog"` with `aria-modal="true"` and a name; beside a page it is a region without `aria-modal`. The recording timer is `role="timer"`, named, and not a live region. All five rating buttons carry `aria-pressed` and one at a time is `true`. |
| `apps/widget/e2e/a11y-bidi.spec.ts` | `ar`; 3 tests | The ticket reference and the email address in the contact form confirmation, the first-message notice, the handoff line and the transcript confirmation are each their own `<bdi>`. |
| `apps/api/e2e/help-center-a11y-reflow.spec.ts` | `en`, `ar` × 640 and 320 CSS px | Every page type (the 11 above, the Arabic fallback, the internal-only wall) at 200 % and 400 % zoom: no sideways scroll, every link, button and field inside the viewport and under its own centre, no heading, button, link or strip with its text cut off. |
| `apps/api/e2e/help-center-a11y-forced-colors.spec.ts` | `en`, `ar` × light, dark; 3 tests | With forced colours on: Tab round every page type, every tabbable control reached, each stop with an outline of at least 2 px and not hidden (the video frame excluded). The pressed "No" differs from "Yes" by border width. Every icon (notes, thanks, header, lists) is drawn in the text colour. |
| `apps/api/e2e/help-center-a11y-semantics.spec.ts` | `en`, `ar`; 5 tests | The search results count is the only live region of its page and comes before the list; "no results" is one `role="status"` that keeps its h2; a search with nothing asked has none. "Was this helpful?" is a named group; after a "No" only "No" is pressed. After "Yes" the thanks is the page's only status and has focus, so it is read. |
| `apps/api/e2e/help-center-a11y-bidi.spec.ts` | `en`, `ar`; 2 tests run in both, 7 in `ar` only | An English title on an Arabic category, section, fallback article, archived article and search result is `lang="en"` and left to right; the fallback article is English and left to right as a whole under an Arabic notice; the reference in an article stays left to right. In both languages: the link to the other language is in that language and direction, and every page declares its own language and direction. The seven Arabic-only tests are skipped in the `en` project because English text is only mixed-direction on a right-to-left page. |

The page lists, the Tab-cycle helper and the icon check are shared in
`apps/api/e2e/help-center-pages.ts`; the widget's are in
`apps/widget/e2e/fixtures.ts`.

What these do not cover: text-only zoom ("Zoom text only" in a browser's
settings), a real Windows High Contrast theme, and the video player's own
frame.

## Findings and fixes

Axe found no violations in any widget state, in either scheme or language. It
found 1 violation on the help center. The keyboard passes found 2 more
problems. All 3 are fixed on the M9-04 branch. A fourth, the video player's
focus ring, is only partly fixed. The zoom, forced-colours, screen-reader-markup
and mixed-direction specs of 2026-10-09 found 5 more, rows 5 to 9, all fixed.
Each was seen failing before its fix:

| # | Where | Finding | WCAG | Fix |
|---|---|---|---|---|
| 1 | Help center, every page | No way to skip the header and its navigation | 2.4.1 Bypass Blocks | A "Skip to content" link is the first element of every page. It is visually hidden until focused. Every `<main>` is `tabindex="-1"` so it can take focus. Strings: `hcSite:nav.skip` in `en` and `ar`. |
| 2 | Help center, article body, dark scheme | axe `link-in-text-block`: a link inside a sentence differed from the text around it by colour alone, under 3:1 | 1.4.1 Use of Color | Links in the article body are underlined in both schemes (`.hd-body a`). |
| 3 | Widget, phone width (≤ 480 px) | The full-screen window left the launcher on top of the Send button. Tab also walked out of the window into the host page it covers. | 2.4.3 Focus Order; 2.1.1 Keyboard | On a phone the window is a modal dialog that keeps Tab inside it (`apps/widget/src/ui/focus-trap.ts`), and the launcher is hidden while the window is open. Minimise and Escape move focus to the launcher after the window has closed. |
| 4 | Help center, article video | When Tab reaches the embedded player, the page draws no focus ring: focus is inside a cross-origin frame | 2.4.7 Focus Visible | Partly fixed. `.hd-video:focus-within` draws a ring on the box around the frame while the frame element has focus, for example when a script focuses it. Chromium does not match `:focus-within` once Tab is inside the cross-origin player, so the provider's own focus styles apply. The ring specs skip those stops, and the video player is on the list for a person below. |
| 5 | Help center, home, search, 404 and 410 pages at 320 px (400 % zoom) | The page scrolled sideways, 375 to 521 px wide: the search field is a flex item whose input has an intrinsic width and could not shrink | 1.4.10 Reflow | `min-inline-size: 0` on `.hd-search-field` (`render/styles.ts`). Found by `help-center-a11y-reflow.spec.ts`. |
| 6 | Widget, thread | The thanks after "Was this helpful?", the rated rating card and its "not sent" line were a `role="status"` or `role="alert"` inside the thread's polite log: a live region nested in a live region, which a screen reader can read twice | 4.1.3 Status Messages | The three lose their role. The log announces what is added to it (`Assistant.tsx`, `CsatCard.tsx`; DESIGN §6.6). Found by `a11y-semantics.spec.ts`. |
| 7 | Help center, article, "What was missing?" step | The pressed "No" differed from "Yes" by border colour and tint only, and forced colours replace both, so the pressed state was invisible | 1.4.1 Use of Color | A 2 px edge on the pressed answer, as the widget's pressed rating has (`.hd-feedback [aria-pressed="true"]`; DESIGN §6.7). Found by `help-center-a11y-forced-colors.spec.ts`. |
| 8 | Help center, search results, Arabic page with an English hit (or the reverse) | The result's title and snippet carried `lang` but not `dir`, so the punctuation at the end of an English title such as "Where is my order?" was placed by the page's direction | 1.3.2 Meaningful Sequence; 3.1.2 Language of Parts | One helper, `otherLanguage()` in `render/text.ts`, writes both attributes for the article, the search results and the inline titles. Found by `help-center-a11y-bidi.spec.ts`. |
| 9 | Widget, Arabic | The ticket reference and the email address in the contact form confirmation, the first-message notice, the handoff line and the transcript confirmation were plain text inside the sentence | 1.3.2 Meaningful Sequence | The `Sentence` component (`apps/widget/src/ui/Sentence.tsx`) sets the named values in `<bdi>`; the catalog strings are unchanged. Found by `a11y-bidi.spec.ts`. |

Everything else the new specs ask for already held: the focus ring on every
tab stop in forced colours, the pressed rating (a 2 px border against 1 px),
the icons (all `stroke="currentColor"`), one strip at a time, the phone
dialog (`aria-modal="true"`, named), the timer (`role="timer"`, not live), the
search count and the thanks (a status with focus), and `lang="en"` on English
titles in lists, links and the fallback article.

### Results, 2026-10-09, this sandbox

Playwright 1.63 with the Chromium 141 headless shell, 4 cores. All passed:

- Widget end-to-end suite: 150 passed, 69 of them the new specs above.
- Api end-to-end suite: 71 passed and 9 skipped; the skipped are the 7
  Arabic-only tests in the `en` project (by design) and 2 older ones. 37 of the
  71 are the new specs.
- Widget unit tests: 183 passed. Api unit tests: 2625 passed.
  `help-center-site.integration.test.ts` against real Postgres and Redis: 18
  passed.

Beside the five defects, the checks were also run against deliberately broken
code and failed as they should: a stylesheet with no focus outline, a 1 px
pressed rating, an icon with a hard-coded stroke, and a widget window 900 px
wide.

### The flaky contrast failure in `widget.spec.ts`

[M4](M4-widget-and-realtime.md#gaps-and-follow-ups) recorded this as a gap:
"chat: queue position, agent, typing, and the ended state with a transcript"
failed axe `color-contrast` in the header about once in four local runs.

It was not reproduced during this audit. Before the change, the test passed 60
of 60 repeats at 6 workers. A run at 16 workers on 4 cores failed only by
timing out. After the change it passed 99 of 100 repeats at 4 workers, and the
one failure was a browser crash, not axe. Two things in the code could produce
the failure, and both are changed:

- **The theme stylesheet was replaced on every state change.** The widget's
  `paint` ran `replaceSync` on its theme sheet each time the controller
  notified, even when the CSS was identical. Each call restyled the whole
  shadow tree, while the header was being re-rendered for the agent, the queue
  or typing. `changesOnly` in `apps/widget/src/mount.tsx` now replaces the
  sheet only when its text changes.
- **Axe could start while the window was still changing.** The e2e
  `violations()` helper now calls `settled()` first
  (`apps/widget/e2e/fixtures.ts`). `settled()` waits for the fonts, for any
  finite animation in the shadow root to finish, and for 150 ms with no DOM
  change, up to 2 s.

The widget already sets every transition to 0 ms under
`prefers-reduced-motion`, so no transition had to be removed. If the failure
comes back, record the axe node target and the header's computed colours in
the issue.

## Still to do by a person

What is left cannot be decided from the DOM or the computed style. It needs a
human pass before 1.0, recorded here when done:

- **Screen readers.** NVDA with Firefox, JAWS with Chrome, VoiceOver on macOS
  Safari and on iOS, and TalkBack on Android. The specs above prove the markup
  they read; what they say is the person's check:
  - Chat: is each new message read once, and the banners once rather than on
    every reconnect attempt? Is the typing indicator quiet enough? Is "Sent" or
    "Seen" read only when focus is on the message?
  - The phone-width window: is it announced as a dialog, and is the page behind
    it really unreachable with the virtual cursor? `aria-modal` support varies
    between screen readers.
  - Voice recording: does the timer stay quiet instead of interrupting every
    second?
  - Arabic pages: does the reader switch voice for an English title
    (`lang="en"`), and say a reference or an email address as one piece?
  - Help center: is the results count read after a search, which loads a new
    page? Does the thanks read once focus lands on it after "Was this
    helpful?"?
  - CSAT, in the widget and on the CSAT page (`apps/admin/e2e/csat.spec.ts`
    proves `aria-pressed`): how does each screen reader name the pressed
    rating?
- **The embedded video player.** Its focus and controls are the provider's, and
  axe and the ring specs exclude its frame.
- **Brand themes.** The audit uses the stock accent. The admin refuses an
  accent under 3:1 on the surface (DESIGN §8). A brand's custom CSS is not
  checked at save time ([M5 gaps](M5-help-center.md#gaps-and-follow-ups)), so
  a brand that overrides focus, borders or `forced-color-adjust` can undo
  what the specs prove for the stock theme.

## Running it

```sh
pnpm --filter @helpdock/widget e2e a11y
pnpm --filter @helpdock/api build && pnpm --filter @helpdock/api e2e help-center-a11y
```

The argument is Playwright's file filter: `a11y` picks the widget's axe audit,
reflow, forced-colours, semantics and bidi specs, and `help-center-a11y` the
help center's five. Do not put `--` before it: pnpm passes that on and
Playwright then runs the whole suite. The api specs read the build, so `build`
comes first.

The specs are part of the projects CI already runs: the `widget-e2e` job and
the api project on the admin `e2e` job's first shard. A new `*.spec.ts` in
those folders joins them without a config change.
