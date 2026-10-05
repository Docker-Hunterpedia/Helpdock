# Accessibility audit: widget and help center

Status: automated and keyboard passes done; screen-reader pass outstanding
Audited: 2026-10-05
Deliverable: M9-04 ([PRD §4 · M9](../planning/PRD.md#m9-hardening-and-10)), against
[REQUIREMENTS §5.4](../planning/REQUIREMENTS.md) (WCAG 2.1 AA on the widget and
help center) and the [DESIGN §10](../../DESIGN.md#10-accessibility-checklist)
checklist.

This page records what was checked, with which tools, what was found and fixed,
and what still needs a person with a screen reader. The checks are Playwright
specs, so CI repeats them on every pull request. This is not a one-off report.

## Tools

| Tool | Version | Used for |
|---|---|---|
| axe-core | 4.13.0 | Rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. Axe walks the widget's open shadow root. |
| @axe-core/playwright | 4.13.0 | Runs axe in the page |
| @playwright/test | 1.63.0 | Keyboard-only passes, emulated `prefers-color-scheme` and `prefers-reduced-motion` |
| Chromium | the build Playwright 1.63 installs in CI; Chromium 141 headless shell for the local run of this audit | The browser |

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

## Findings and fixes

Axe found no violations in any widget state, in either scheme or language. It
found 1 violation on the help center. The keyboard passes found 2 more
problems. All 3 are fixed on the M9-04 branch. A fourth, the video player's
focus ring, is only partly fixed:

| # | Where | Finding | WCAG | Fix |
|---|---|---|---|---|
| 1 | Help center, every page | No way to skip the header and its navigation | 2.4.1 Bypass Blocks | A "Skip to content" link is the first element of every page. It is visually hidden until focused. Every `<main>` is `tabindex="-1"` so it can take focus. Strings: `hcSite:nav.skip` in `en` and `ar`. |
| 2 | Help center, article body, dark scheme | axe `link-in-text-block`: a link inside a sentence differed from the text around it by colour alone, under 3:1 | 1.4.1 Use of Color | Links in the article body are underlined in both schemes (`.hd-body a`). |
| 3 | Widget, phone width (≤ 480 px) | The full-screen window left the launcher on top of the Send button. Tab also walked out of the window into the host page it covers. | 2.4.3 Focus Order; 2.1.1 Keyboard | On a phone the window is a modal dialog that keeps Tab inside it (`apps/widget/src/ui/focus-trap.ts`), and the launcher is hidden while the window is open. Minimise and Escape move focus to the launcher after the window has closed. |
| 4 | Help center, article video | When Tab reaches the embedded player, the page draws no focus ring: focus is inside a cross-origin frame | 2.4.7 Focus Visible | Partly fixed. `.hd-video:focus-within` draws a ring on the box around the frame while the frame element has focus, for example when a script focuses it. Chromium does not match `:focus-within` once Tab is inside the cross-origin player, so the provider's own focus styles apply. The ring spec skips those stops, and the manual pass below covers them. |

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

These cannot be automated with axe and Playwright. They need a human pass
before 1.0, recorded here when done:

- **Screen readers.** NVDA with Firefox, JAWS with Chrome, VoiceOver on macOS
  Safari and on iOS, and TalkBack on Android. Check in each:
  - Chat:
    - Is each new message read once? The thread is a polite live log.
    - Are the banners read once, and not on every reconnect attempt? These are
      the status strips: Reconnecting, Back online, queue position and out of
      hours.
    - Is the typing indicator quiet enough?
    - Is "Sent" or "Seen" read only when focus is on the message?
  - The phone-width window: is it announced as a dialog, and is the page behind
    it really unreachable with the virtual cursor? `aria-modal` support varies
    between screen readers.
  - Voice recording: the timer is `role="timer"`, and it should not interrupt
    every second.
  - Mixed-direction text in Arabic: ticket references, email addresses and
    English article titles inside Arabic pages, in `<bdi>` and with `lang`.
  - Help center search: is the results count read after a search? Does the
    thanks status read after the redirect that follows "Was this helpful?"?
  - CSAT page: the five rating buttons use `aria-pressed`. Check how each
    screen reader names the pressed one.
- **Zoom and reflow.** 200 % browser zoom on the help center and the widget,
  and 400 % (320 CSS px) reflow on the help center. Playwright checks only the
  widget at 320 px.
- **Forced colours** (Windows High Contrast). Check the focus rings, the
  pressed rating and feedback buttons, and the message-state icons.
- **The embedded video player.** Its focus and controls are the provider's,
  and axe excludes its frame.
- **Brand themes.** The audit uses the stock accent. The admin refuses an
  accent under 3:1 on the surface (DESIGN §8). A brand's custom CSS is not
  checked at save time ([M5 gaps](M5-help-center.md#gaps-and-follow-ups)).

## Running it

```sh
pnpm --filter @helpdock/widget e2e -- a11y-audit
pnpm --filter @helpdock/api build && pnpm --filter @helpdock/api e2e -- help-center-a11y
```

Both specs are part of the projects CI already runs: the `widget-e2e` job and
the api project on the admin `e2e` job's first shard.
