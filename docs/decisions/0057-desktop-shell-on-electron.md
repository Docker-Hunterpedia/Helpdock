# 0057 The desktop shell on Electron

Status: proposed
Date: 2026-10-20

## Context

M17 makes the admin an installable web app
([ADR 0049](0049-installable-admin-before-native-agent-apps.md)). Some agents
still want a desktop application: browsers with weak PWA support (Firefox,
several Linux setups), a dock badge and OS notifications outside the browser,
and sign-in through the system browser for identity providers that refuse
embedded browsers. A desktop shell must load the operator's own instance and
nothing else, and it adds a signed release artefact the project ships.

Planned in [M20 Native clients and SDKs](../in-development/M20-native-clients-and-sdks.md)
(M20-04). Code-signing budget is owner decision D-59.

## Decision

1. The shell is built on **Electron**, under `clients/desktop`.
2. A server picker validates the instance by reading a public, secret-free
   `GET /api/install/client-config`; the window loads that instance's admin and
   nothing else.
3. **Hardening** follows the Electron security checklist: `contextIsolation`,
   `sandbox`, no Node in the renderer, navigation locked to the instance's
   origins, everything else opened in the default browser (https and `mailto:`
   only), named IPC with checked arguments, every permission denied except
   notifications, deep links (`helpdock://open?path=`) restricted to admin
   paths and validated in main.
4. **Sign-in in the system browser** through a native PKCE handoff,
   `POST /api/auth/native/exchange`: single use, 10 minutes, audited, behind the
   existing auth guards.
5. **Updates** through `electron-updater` from GitHub Releases `desktop-v*`,
   with sha512 checks and signed builds on macOS, Windows and Linux; the
   release's `SHA256SUMS` is signed with Cosign as the server bundle is (M15-01).
   Signing credentials live in a GitHub Environment with required reviewers;
   builds stay unsigned, and labelled so, until the owner provides them.

## Consequences

- TypeScript only: no Rust toolchain for a solo maintainer, which matches the
  stack rule.
- Chromium everywhere gives consistent Arabic and Persian shaping and RTL, and
  the same behaviour as the Chromium-based browsers the admin is tested in.
- About 100 MB installers, and Electron security releases to follow.
- ARCHITECTURE §1 and §2 gain Electron and `clients/desktop`; `apps/*` and
  `clients/*` never import each other.

## Alternatives considered

- **Tauri:** about 10 MB installers and mandatory update signing, but it adds
  Rust, and WebKitGTK on Linux is the weak spot for Arabic and Persian shaping.
- **No desktop shell, PWA only:** the default until there is demand; this
  record applies when M20 starts.
