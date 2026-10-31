# Accessibility

Helpdock is used by customers who need help and by the people who give it, so it should work with a keyboard, a screen reader, zoom and contrast settings, in English and Arabic. This page states what Helpdock aims for, what is checked and how, what is known not to work yet, and how to report a barrier.

## Commitment

Helpdock aims to meet [WCAG 2.1](https://www.w3.org/TR/WCAG21/) Level AA on its three user interfaces:

- **The chat widget and the help center**, which customers use. WCAG 2.1 AA on these two is a requirement of 1.0 ([REQUIREMENTS §5.4](docs/planning/REQUIREMENTS.md)), and they were audited for it in M9-04 ([accessibility audit](docs/completed/accessibility-audit.md)). The hosted web form and the CSAT page are customer-facing too and are checked with axe.
- **The admin app**, which agents and admins use. It is checked with axe against the same WCAG 2.1 A and AA rules, in both languages, but it has not had the audit the widget and the help center had, and it has a known Level A gap ([below](#known-limitations)).

Every screen is built from [DESIGN.md](DESIGN.md), and every pull request that touches a user interface ticks its [accessibility checklist](DESIGN.md#10-accessibility-checklist): contrast, real controls with a visible focus ring, labelled icon buttons, target sizes, live regions, focus handling in dialogs, zoom, forced colours, direction isolation, both languages, and reduced motion. Right-to-left layouts use logical CSS properties only ([DESIGN §7](DESIGN.md#7-right-to-left)).

## What is checked, and how

The checks are Playwright specs, so CI repeats them on every pull request. The [accessibility audit](docs/completed/accessibility-audit.md) lists every state and page they cover and every defect they found.

| Check | Widget | Help center | Admin app |
|---|---|---|---|
| axe-core 4.13 with the `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` rules, in `en` and `ar` | Every state of every mode, in the light and the dark scheme (`apps/widget/e2e/a11y-audit.spec.ts`) | Every page type, in both schemes (`apps/api/e2e/help-center-a11y.spec.ts`) | Sign-in, two-factor, the shell, the ticket workspace, contacts, staff, security and ticketing settings, with their dialogs and menus (`apps/admin/e2e/a11y.spec.ts`), and axe checks in the feature specs |
| Keyboard only: tab order, visible focus rings, Escape, focus trapped in the phone-width window | Yes | Yes, including the skip link and "Was this helpful?" | In individual feature specs, not as a sweep |
| Zoom and reflow: no sideways scroll at 200 % (640 CSS px), every control reachable and not clipped | Yes; the phone layout at 320 px | Yes, at 200 % and at 400 % (320 CSS px) | No dedicated spec |
| Forced colours (Chromium's emulation, the mechanism Windows High Contrast uses): focus rings, pressed states and status icons still show | Yes, light and dark | Yes, light and dark | No dedicated spec |
| Screen-reader markup: one polite log for the thread with no live region inside it, one status strip at a time, the phone dialog, the recording timer, pressed ratings | Yes | Yes, the search count, "no results" and the thanks | In individual feature specs, not as a sweep |
| Mixed direction: references, email addresses and other-language text isolated with `<bdi>` or their own `lang` and `dir` | Yes, in `ar` | Yes | In individual feature specs, not as a sweep |

The audit specs and the admin app's axe spec run with `prefers-reduced-motion: reduce`, so they measure the settled state; the widget and help center stylesheets honour that setting, and the widget drops every transition to 0 ms under it.

## Tested environments

- **Browser in CI:** Chromium, the build Playwright installs, for every spec above. Firefox and Safari are not run in CI.
- **Screen readers:** the [screen-reader pass](docs/guides/screen-reader-pass.md) walks 15 steps on the widget, the help center and the CSAT page, in English and Arabic, with NVDA and Firefox on Windows, JAWS and Chrome on Windows, VoiceOver and Safari on macOS and on iOS, and TalkBack and Chrome on Android. The owner confirmed the pass complete on 2026-10-19; its results are held by the owner and are not recorded in this repository ([M9 record](docs/completed/M9-hardening-and-1-0.md)). The admin app is not part of the pass.

Other browsers and assistive technologies are not tested. A barrier in one of them is still a bug; please report it.

## Known limitations

These are known in 1.0.0. Each one is tracked where it says.

- **Single-key shortcuts cannot be turned off** in the admin app's ticket workspace (`j`, `k`, `r`, `n`). WCAG 2.1.4 Character Key Shortcuts (Level A) requires a way to turn them off or remap them. They do not fire while focus is in a field. A per-person switch is planned in [M14-01](docs/completed/M14-inbox-productivity.md) ([ADR 0038](docs/decisions/0038-keyboard-registry-and-command-palette.md), proposed). The same shortcuts do not work on an Arabic keyboard layout, because they match the character rather than the physical key; M14-01 fixes that too.
- **The shortcuts are not listed anywhere on screen** (UX-09 in the [1.0 UX review](docs/completed/ux-review-1-0.md)); a `?` sheet is planned in M14-01.
- **Fixed for the 1.0.1 patch, present in 1.0.0:** user-written text such as subjects and message bodies is not direction-isolated in the admin app (UX-02); identifiers such as phone numbers and visitor ids reorder in Arabic (UX-03); a ticket row's accessible name leaves out its status, SLA and contact, and priority is shown by colour alone (UX-06).
- **The admin app's narrow layouts.** Below 1024 px the Tickets screen opens on an empty view with the list in a drawer (UX-13, planned in [M14-22](docs/completed/M14-inbox-productivity.md)); at 1280 × 720 the reply composer leaves little of the thread visible (UX-01, planned in [M14-19](docs/completed/M14-inbox-productivity.md)). The admin app has no reflow or forced-colours spec of its own.
- **The help center on a phone.** Below 1024 px the section navigation stacks above the article, a screen of links before the title (UX-14, planned in [M19-06](docs/in-development/M19-customer-surfaces-polish.md)).
- **The embedded video player** in help center articles belongs to its provider. Once Tab is inside the cross-origin frame, Helpdock cannot draw its focus ring, and its controls are the provider's ([audit finding 4](docs/completed/accessibility-audit.md#findings-and-fixes)).
- **Brand themes.** The checks use the stock theme. The admin refuses an accent colour under 3:1 against the surface ([DESIGN §8](DESIGN.md#8-brand-theming)), but a help center's custom CSS is not checked when it is saved, so CSS that overrides focus rings, borders or forced colours can undo what the checks prove.
- **Not covered by the checks:** text-only zoom (a browser's "Zoom text only" setting) and a real Windows High Contrast theme, as opposed to Chromium's emulation of it.

## Report a barrier

Open an [accessibility barrier report](https://github.com/Docker-Hunterpedia/Helpdock/issues/new?template=accessibility_barrier.yml). It asks where it happened, your assistive technology, your browser, the language and direction, and what blocks you. Barriers are treated as bugs.

If the report would expose something you would rather not post in public, such as your own health information or a customer's data, email it privately to [contact@oday-bakkour.com](mailto:contact@oday-bakkour.com) with a subject that starts with "Accessibility:".

If you run Helpdock for your own customers, your organisation is responsible for its own accessibility statement; the audit and this page are there to help you write it.
