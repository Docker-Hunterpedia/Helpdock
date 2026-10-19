# 0056 Public npm packages for the widget client and the React Native SDK

Status: proposed
Date: 2026-10-20

## Context

Teams with their own mobile apps want Helpdock chat inside them. The widget
protocol is documented for native apps (M4-10), but each team would reimplement
the delivery contract (client ids, sequence numbers, catch-up, deduplication)
on its own. Helpdock publishes nothing to npm today: the release guide ships a
container image and a GitHub release. A public package is a new supply-chain
surface and a support promise against server versions.

Planned in [M20 Native clients and SDKs](../in-development/M20-native-clients-and-sdks.md)
(M20-01, M20-02). The licence of these packages is owner decision D-61.

## Decision

1. Extract a headless TypeScript client, **`@helpdock/widget-client`**, from the
   widget's transport and state: session and identity, the delivery contract,
   typing and read state, attachments, CSAT, help-center search, signed
   identity; Zod schemas from `packages/schemas`; no DOM. The widget itself
   moves onto it, under the size check.
2. Build **`@helpdock/react-native`** on it.
3. Both are **public npm packages** under the `@helpdock` scope, versioned
   separately from the product, each with its own changelog, published with
   `npm publish --provenance` from CI, with organisation 2FA, CODEOWNERS on the
   SDK paths, Renovate and an SBOM per package release.
4. A **conformance kit** (a scripted scenario suite against a real api) is the
   contract every SDK must pass, including a community Flutter SDK.
5. Each package states the server versions it supports.
6. This amends the release guide's "nothing is published to npm".

## Consequences

- Host apps get the delivery contract right without reimplementing it.
- The project takes on a second release line and its support window.
- The packages' licence may differ from the server's AGPL (D-61); the server
  stays AGPL either way.

## Alternatives considered

- **Protocol documentation only:** every team reimplements the hardest part.
- **Publish under the product's version:** forces an SDK release on every
  server release and the reverse.
- **Vendor the client into each SDK repository:** protocol drift between SDKs.
