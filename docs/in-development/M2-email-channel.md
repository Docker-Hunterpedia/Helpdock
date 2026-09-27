# M2 Email channel

Status: in progress
Started: 2026-09-27
Owner: @Docker-Hunterpedia

## Scope

[PRD, M2 Email channel](../planning/PRD.md#m2-email-channel). Depends on M1; runs in parallel with M3.

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M2-01 | `ChannelAdapter` interface and `ConversationRouter` | #80 | not started |
| M2-02 | Inbound IMAP polling | #81 | not started |
| M2-03 | Inbound parse webhooks | #82 | not started |
| M2-04 | Threading and the participant check | #83 | not started |
| M2-05 | Outbound SMTP through the outbox | #84 | done: per-brand SMTP, department senders, signatures, `email.send` with a deterministic `Message-ID`, five attempts then Failed sends; see [outbound email](../guides/outbound-email.md) |
| M2-06 | Auto-responders and loop protection | #85 | done: acknowledgment and out-of-hours (en/ar templates), `Auto-Submitted`, `Precedence`, per-sender cap; business hours default to open until M3 wires them |
| M2-07 | Email security: sanitised HTML and remote images | #86 | not started |
| M2-08 | Admin: mailboxes, inbound parse and email health | #87 | outbound half done: Channels › Outgoing email (SMTP + test, senders, auto-replies, Failed sends), Email signature tab, the composer's email mode; Mailboxes is the inbound half |

## Artboards

On the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ), under "M2 Email channel": ARTBOARDS_M2.

## Exit criteria

- [ ] Email to a mailbox creates a ticket; agent reply arrives in the customer's inbox; customer reply threads onto the same ticket. Verified with Mailpit in CI.
- [ ] A reply quoting a valid ticket number from a non-participant address creates a separate ticket and never attaches to the original.
- [x] Delivering the same outbox job twice sends one email. (`apps/api/src/email/email.integration.test.ts`, against Mailpit)
- [x] Sending fails gracefully into the DLQ, visible in admin. (same suite, and `apps/admin/e2e/email.spec.ts`)

## Open questions

- None yet.

## Pull requests

- None yet.
