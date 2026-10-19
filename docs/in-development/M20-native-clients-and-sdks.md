# M20 Native clients and SDKs

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: later 1.x, when the M17 PWA has shown demand (owner decisions D-01, D-02)
Depends on: M17 (the installable admin ships first), M15-01 (signed release artefacts), M4 (widget protocol)
Effort: about 45 working days for one person with Flutter community-led, about 57 with Flutter built in-house; 5–6 weeks of calendar time with parallel tracks (see Deliverables)
PRD: [Phase 5 · M20](../planning/PRD.md#m20-native-clients-and-sdks)
Owner decisions: D-59 to D-61 in [decisions-1-x.md](../planning/decisions-1-x.md#m20-native-clients-and-sdks)
ADRs (proposed): [0056](../decisions/0056-public-npm-packages-for-client-sdks.md), [0057](../decisions/0057-desktop-shell-on-electron.md)

A headless widget client with a conformance kit, a React Native SDK, a Flutter SDK led by the community, and a hardened Electron desktop shell around the instance's own admin.

This is the second half of the apps and languages area. Why it is a milestone
of its own rather than part of M17 is explained in
[M17 Apps and languages](M17-apps-and-languages.md#why-m20-is-a-separate-milestone).
Its deliverables were drafted as M17-09 to M17-12; they are renumbered here.

Effort is in working days for one experienced contributor working with AI
agents, with the Definition of done included: tests, docs and review fixes.

## Goal

Teams with their own mobile apps can embed Helpdock chat natively, starting
with React Native, on a headless client that any SDK can be measured against.
Agents who want "a real app" on desktop, or who use a browser without good PWA
support, get a signed desktop shell that loads their own instance and nothing
else. No part of it needs a service the project would host.

## Scope

In scope: track B (widget SDKs, M20-01 to M20-03), track C (desktop, M20-04)
and docs (M20-05).

## Non-goals

- Native iOS and Android **agent** apps and a project-run push relay
  ([ADR 0049](../decisions/0049-installable-admin-before-native-agent-apps.md)).
- A push service for SDK host apps: the host app's own backend pushes through
  its own FCM or APNs.
- Offline ticket data in the desktop shell.
- SDKs for platforms other than React Native and Flutter.

## Deliverables

**Track B — widget SDKs**

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M20-01 | **`@helpdock/widget-client`** (formerly drafted as M17-09): a headless TypeScript client extracted from `apps/widget/src/transport` and `apps/widget/src/state`.<br>• Session and identity, delivery contract (`client_id`, `seq`, catch-up on gaps, SSE fallback where the platform has `EventSource`), typing and read state, attachments (presign and upload), CSAT, help-center search, signed identity.<br>• Zod schemas from `packages/schemas/src/widget-protocol.ts`; Socket.IO client; no DOM.<br>• **Conformance kit**: a scripted scenario suite against a real api in Testcontainers (send, drop network, duplicate, reconnect, handoff, CSAT) that any SDK, including Flutter, must pass.<br>• The widget itself moves onto the client, with a size check so it does not grow.<br>• **First public npm package**: publishing pipeline with `npm publish --provenance`, org 2FA, its own version line and changelog ([ADR 0056](../decisions/0056-public-npm-packages-for-client-sdks.md)). | M4-10, D §7 | 9 | — |
| M20-02 | **React Native SDK `@helpdock/react-native`** (formerly M17-10).<br>• `<HelpdockChat/>` screen and conversation list, themed from the brand's widget config tokens, RTL via `I18nManager`, locales from the M17-01 registry, attachments through **injected** pickers (no hard Expo dependency).<br>• `visitorSecret` stored through an injected secure store, with a documented warning when only AsyncStorage is given.<br>• Push recipe: the host app's backend listens to `ticket.replied` webhooks and pushes through its own FCM or APNs (no Helpdock push service).<br>• Expo example app; Jest plus React Native Testing Library; the conformance kit; nightly Android emulator smoke. | M4-10 | 12 | M20-01 |
| M20-03 | **Flutter SDK** (formerly M17-11; optional or community): a Dart port of the client and UI against the same conformance kit, published to pub.dev. Recommended as community-led with a maintainer review budget of about 4 days; 16 days if built in-house (D-60). | — | 4 (review) / 16 | M20-01 |

**Track C — desktop**

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M20-04 | **Desktop shell on Electron** (formerly M17-12; [ADR 0057](../decisions/0057-desktop-shell-on-electron.md)), under `clients/desktop`.<br>• Server picker that validates the origin by reading a small `/api/install/client-config` (new, public, no secrets); a window that loads the **instance's own admin** and nothing else.<br>• Hardening, following the Electron security checklist: `contextIsolation`, `sandbox`, no Node in the renderer, navigation locked to the instance origins, everything else opened in the default browser (https and `mailto:` only), named IPC with checked arguments, every permission denied except notifications.<br>• OS notifications via the renderer's Notification API; dock and taskbar badge through a `window.helpdockDesktop.setBadge(n)` bridge the admin uses when present; `helpdock://open?path=` deep links restricted to admin paths.<br>• **Sign-in in the system browser** for Google, GitHub and IdPs that refuse embedded browsers. This needs a small api addition: a native PKCE handoff `POST /api/auth/native/exchange`, behind the existing auth guards.<br>• `electron-updater` from GitHub Releases `desktop-v*` with sha512 checks; signed builds on macOS, Windows and Linux; `SHA256SUMS` signed with Cosign as in M15-01. | A §1 (ADR 0057) | 16 | M15-01, M17-06 |

**Cross-track**

| Id | Deliverable | Spec | Effort (d) | Depends on |
|---|---|---|---|---|
| M20-05 | **Docs:**<br>• `sdk-react-native.md` (install, theming, identity, the push recipe, the secure-store warning);<br>• the desktop part of `install-the-app.md` (downloads per platform, signed or unsigned, updates);<br>• widget-protocol updates (the client package, the conformance kit);<br>• `CONTRIBUTING.md` (writing an SDK against the conformance kit);<br>• ARCHITECTURE §1 (Electron, the SDK packages) and §2 (`clients/desktop`, `sdks/react-native`, `packages/widget-client`; `apps/*` and `clients/*` still never import each other). | AGENTS DoD 1 | 4 | all |

**Totals:** track B 25 days with Flutter community-led (37 with Flutter
in-house), track C 16 days, docs 4 days: about **45 days**, or **57 days** with
Flutter built in-house.

## Data model

- **No new tenant tables.** The SDKs and the desktop shell use existing visitor
  and staff routes, plus:
  - a public, cached, secret-free `GET /api/install/client-config`
    (`{ apiOrigin, adminOrigin, version, ssoProviders: [names only] }`);
  - the native sign-in exchange route `POST /api/auth/native/exchange`, whose
    single-use handoff state lives in Redis, as the other sign-in request
    states do.

## Security and privacy

- **Desktop:**
  - The Electron security checklist above.
  - Deep links and IPC validated in main.
  - The native auth handoff requires a PKCE verifier, is single-use with a
    10-minute lifetime, and is audited.
  - Updates require signature and sha512.
  - **Code-signing credentials** (Apple Developer ID, Windows Azure Trusted
    Signing) live in a GitHub Environment with required reviewers. Builds stay
    unsigned until the owner provides them (D-59), and unsigned builds are
    labelled so.
- **SDKs:**
  - npm provenance, org 2FA, scoped `@helpdock/*`, Renovate.
  - The visitor secret goes in the platform's secure store when the host
    provides one.
  - The signed-identity HMAC is always computed on the host's backend, never in
    the app (documented with a test that the SDK has no HMAC helper taking a
    secret).
  - The origin header remains a convenience (widget protocol), not a security
    boundary.
- **`client-config`** exposes no secret and is covered by a test that says so.

## Design artboards

Drawn by the orchestrating session on the design canvas before the screens are
built.

| Artboard | For | Must show |
|---|---|---|
| `Desktop/ServerPicker`, `Desktop/Offline`, `Desktop/Window-mac`, `Desktop/Window-win`, EN and AR | M20-04 | Picker validation errors, offline page, window chrome with the admin inside |
| `RN/Chat-EN`, `RN/Chat-AR`, `RN/ConversationList` | M20-02 | Native rendering of DESIGN §6.6 widget components (a new "native widget" subsection in DESIGN) |

## Tests

- **Unit:**
  - `widget-client` state machine;
  - the desktop main-process validators (navigation, IPC, deep links).
- **Integration:**
  - native exchange (PKCE pass, missing verifier, replay, expiry);
  - `client-config` exposes no secret;
  - the conformance kit against a real api (CI for `widget-client` and React
    Native, and nightly for Flutter if built).
- **Size:** the widget's initial bundle stays ≤ 40 KB after it moves onto
  `widget-client`.
- **React Native:** Jest plus React Native Testing Library, the Expo example
  app, nightly Android emulator smoke.
- **Desktop:** Playwright's Electron support for picker, navigation lock and
  deep link (adds no new tool).
- **Manual matrix recorded in the milestone doc:** signed desktop installs on
  macOS, Windows and Linux.

## Docs

Listed in M20-05.

## ADRs

- **[0056](../decisions/0056-public-npm-packages-for-client-sdks.md)**, public npm
  packages: `@helpdock/widget-client` and `@helpdock/react-native` versioned
  separately from the product. This amends the release guide's "nothing is
  published to npm", and covers provenance and the support window against
  server versions.
- **[0057](../decisions/0057-desktop-shell-on-electron.md)**, desktop shell on
  **Electron** rather than Tauri: TypeScript only, so no Rust toolchain for a
  solo maintainer, which matches the stack rule; Chromium everywhere gives
  consistent Arabic and Persian shaping and RTL, where WebKitGTK on Linux is the
  weak spot; behaviour equals the Chrome-based admin users already have;
  `electron-updater` and a well-known hardening checklist. Costs: about 100 MB
  installers and Electron security releases to follow.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SDK support burden across React Native versions | Medium | Support the two latest React Native minors; the conformance kit catches protocol drift; the Flutter SDK left to the community |
| Public npm packages are a new supply-chain surface | Medium | Provenance, 2FA, CODEOWNERS on `sdks/`, Renovate, and an SBOM per package release |
| Desktop signing costs and certificate custody | Medium | Owner decision (D-59); unsigned builds labelled; secrets in a protected Environment |
| Electron security releases to follow | Medium | `electron-updater` with signature and sha512 checks; Renovate on Electron; the hardening checklist under unit tests |
| Moving the widget onto `widget-client` grows the widget | Medium | Size check in the same PR; the client has no DOM code |

## Open questions

1. (D-59) Will the project pay for an **Apple Developer ID** (99 USD a year) and
   **Windows signing** (Azure Trusted Signing, about 10 USD a month)? Without
   them the desktop app warns on install and macOS will not auto-update it.
2. (D-60) **Flutter:** build it in-house (16 days) or invite the community with
   the conformance kit? Recommended: community-led.
3. (D-61) Should the SDKs and `widget-client` publish under the **AGPL** like the
   product? AGPL in a customer's mobile app is a real adoption barrier. An MIT
   or Apache-2.0 licence for the client SDKs only (the server stays AGPL) is
   common practice and needs the owner's decision. Recommended: MIT for the
   SDKs.

## Build order

1. M20-01, then M20-02, with M20-03 community-led on the conformance kit.
2. M20-04 once D-59 is settled; it needs M15-01's signing and M17-06's PWA.
3. M20-05 grows with each.

## Exit criteria

- [ ] `@helpdock/widget-client` and `@helpdock/react-native` pass the
      conformance kit, are published with npm provenance, and the Expo example
      holds a conversation with an agent in both locales.
- [ ] The desktop app installs signed on macOS, Windows and Linux (or is
      labelled unsigned per D-59). It cannot navigate off the instance, signs in
      through the system browser, shows a dock badge and notifications, and
      updates itself only to a newer signed version.
- [ ] The widget's initial bundle is still ≤ 40 KB after moving onto the
      client.

## External dependencies

| Needed for | Dependency | Owner | Status |
|---|---|---|---|
| M20-04 | Apple Developer ID and Windows code signing (Azure Trusted Signing), D-59 | @Docker-Hunterpedia | needed |
| M20-01, M20-02 | An npm organisation `@helpdock` with 2FA enforced | @Docker-Hunterpedia | needed |
