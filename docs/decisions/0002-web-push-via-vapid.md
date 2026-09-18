# 0002 Use web push with VAPID for agent notifications

Status: accepted
Date: 2026-09-18

## Context

Agents must be notified of assignment, replies, `@name` mentions in notes, SLA warnings and breaches, and escalations ([REQUIREMENTS §4.9](../planning/REQUIREMENTS.md#49-notifications)). Three channels are specified: in-app over the realtime gateway, email, and browser push. The notification deliverable is M3-07, but the transport decision belongs in M0 because the key material has to be created by the first-run wizard (M0-08) and stored by the config loader (M0-02).

In-app notifications only reach an agent who is looking at the tab. Email is reliable and slow. Push is the only channel that reaches an agent who has the desk open in a background tab, which is the normal working state.

The deployment shape constrains the choice more than the feature does. Helpdock is AGPL-3.0 and self-hosted: one Docker Compose on the operator's own server, on the operator's own domain, sometimes with no commercial cloud account at all. A push transport that requires every self-hoster to register a project with a vendor before an agent can be told a ticket was assigned is a tax on every install. Ticket subjects and sender names also travel in notification payloads, so whatever relays them must not be able to read them.

## Decision

Use standard Web Push — RFC 8030 message delivery with RFC 8292 VAPID authentication — sent from the worker with the `web-push` npm package (3.6.7, MPL-2.0, Node >= 16).

A single VAPID key pair is generated once per install, during the first-run wizard, with `webpush.generateVAPIDKeys()`. It is stored in the `settings` table. The private key is a secret like any other: encrypted with AES-256-GCM under `APP_MASTER_KEY`, never logged, never returned to the client after save. The public key is served to the admin app to use as the `applicationServerKey` when subscribing.

Sends are `notify.push` jobs on the `notify` queue ([ARCHITECTURE §13](../planning/ARCHITECTURE.md#13-background-jobs-bullmq-queues)), enqueued through the transactional outbox in the same transaction as the domain change, like every other side effect ([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)). A `404` or `410 Gone` from a push service means the subscription is dead and the row is deleted.

## Consequences

- Nothing to sign up for. An install has working push the moment the wizard finishes, with no vendor account, no project id and no API key. The browser picks its own push service; the payload is encrypted to the subscription's keys, so that service relays ciphertext and cannot read ticket content.
- `web-push` is MPL-2.0, which is file-level copyleft and compatible with AGPL-3.0. We consume it unmodified as a dependency, so it creates no obligation beyond what we already meet. If we ever patch it, those files stay MPL-2.0 and the patches must be published as such.
- Rotating the VAPID key pair invalidates every existing subscription on the install. We therefore treat the pair as long-lived, keep exactly one, and document rotation as an operation that re-prompts every agent. It is not automated.
- Delivery is best effort. Push services drop messages for devices that stay offline past the TTL, and there is no read receipt. Push is an additional channel, not a system of record: in-app and email remain the answer to "was the agent told".
- Browser coverage is uneven and outside our control. On iOS and iPadOS, Web Push works only for a site added to the Home Screen as a web app (16.4 and later), and Apple's Digital Markets Act changes to how home-screen sites open in the EU have made that path less dependable there. The notification preferences screen states the limitation rather than offering a toggle that silently does nothing.
- Push requires HTTPS and a service worker in the admin app. Our Caddy setup terminates TLS by default, but an operator running plain HTTP on a LAN gets no push at all. The install guide has to say so, and the notification service must behave correctly with push disabled, because on a fair number of installs it will be.

## Alternatives considered

- **Firebase Cloud Messaging.** Rejected. It would require every self-hoster to create a Google Cloud project and hold a service-account credential purely to notify their own staff, it routes notification metadata through Google, and it adds a proprietary SDK to an AGPL product whose entire premise is that you run it yourself. It would also not remove any work: Safari is not an FCM target, so we would end up maintaining the standard VAPID path anyway and have two transports instead of one.
- **No push in v1 — in-app and email only.** A defensible scope cut, and the honest fallback for installs without TLS. Rejected as the default because the requirement is explicit and because, once VAPID keys exist, push is the cheapest of the three channels to add: a service worker, a subscription table and one queue consumer. The fallback survives in the design — the notification service must work with push switched off — but it is not the plan.
