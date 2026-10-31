# 0037 Paced notification email and digests

Status: accepted (M14-10; owner decisions D-25 to D-27). Decisions 1 to 7 are built by M14-10; decision 8, the unsubscribe, by M14-11 (built).
Date: 2026-10-20

## Context

Helpdock 1.0 (M3-07) sends one email per notification from the system sender,
alongside the in-app bell and web push, with a per-person matrix of kind ×
channel (`notification_prefs`, global per person). A busy agent gets dozens of
emails a day, many about tickets they have already read in the app. There is
no batching, digest, pause or unsubscribe, and nothing re-checks a notification
when its email is sent.

Constraints: a worker job runs inside one brand (D §1.4); state that matters
must survive Redis loss (D §10); every side effect goes through the outbox;
staff tokens are derived from `APP_MASTER_KEY`.

The plan is [M14-10 and M14-11 in M14 Inbox productivity](../completed/M14-inbox-productivity.md#m14-10-notification-pacing-engine);
owner decisions D-25, D-26 and D-27.

## Decision

1. **Email schedules per person:** Right away (default), Hourly digest, Daily
   digest at a chosen hour in the person's time zone, Off. The bell is always
   immediate and push stays immediate; both obey pause.
2. **Right away is paced:** first wait 2 min, back-off 10, 20, 40, 60 min while
   more arrives, reset after 2 quiet hours; urgent kinds (mention, SLA breach,
   escalation) may cut the wait at most every 5 min and 8 times a day; caps of
   6 an hour and 40 a day. Each value is an install setting with an `HD_*`
   override.
3. **Pacing state lives in Postgres** (`notification_email_batches`,
   `notification_email_pacing`), not Redis, and `notify.email_rebuild`
   recreates batch jobs on boot and hourly, so Redis loss loses no email. The
   pacing row is also the per-person lock every path takes before it changes
   that person's batches.
4. **Every send re-checks** each row: unread, the ticket exists and the
   recipient's department scope still covers it, the recipient is active with
   a role in the brand, not paused, not unsubscribed, schedule not Off. A row
   that fails is marked `skipped_*` and never sent later.
5. **Presence hold:** while the recipient is online in the brand, a right-away
   email waits until they have been away or offline for 5 minutes, or at most
   15 minutes.
6. **Digests are per brand**, because a worker job runs inside one brand; a
   cross-brand digest would need an audited all-brands system path for a
   convenience.
7. **Pause drops, never delays:** rows created during a pause stay in the bell
   and are never emailed.
8. **One-click unsubscribe per RFC 8058:** `List-Unsubscribe` with an HTTPS
   link and `List-Unsubscribe-Post`; a POST unsubscribes at once, a GET opens a
   confirmation page so link scanners unsubscribe nobody. The token is an HMAC
   under a key derived from `APP_MASTER_KEY` with HKDF (purpose
   `notify-unsubscribe`) over the user id and issue date, valid one year;
   idempotent, rate-limited and audited. The page is a public route in the admin
   bundle, as the CSAT page is (ADR 0010).

## Consequences

- An agent gets a handful of grouped emails instead of one per event, and none
  about what they already read.
- An SLA-breach email can wait up to the urgent cut; the bell and push remain
  immediate, and the state machine is unit-tested on a fake clock.
- A person in three brands gets up to three digests; unsubscribing stops
  notification email from every brand, because preferences are global per
  person.
- The per-notification `notify.email` job is retired; existing installs move to
  Right away (batched) on upgrade, which the release note states.
- Two new owner-scoped tenant tables; DOMAIN-RULES gains §20 Notification
  delivery (M14-10) and, with M14-11, the unsubscribe token in §4.6.
- Until M14-12 gives each person a time zone, the daily digest's hour is read
  in the brand's.

## Alternatives considered

- **Pacing state in Redis:** simpler, but lost with Redis, against D §10.
- **One cross-brand digest:** needs an all-brands worker path for a
  convenience, against D §1.4.
- **Hold indefinitely while the person is in the app:** a tab left open all day
  would mean no email ever.
- **Unsubscribe on GET:** link scanners in mail gateways would unsubscribe
  people without their knowledge.
