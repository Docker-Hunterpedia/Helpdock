# 0020 Record authentication events in install scope, as the `auth` system principal

Status: accepted
Date: 2026-10-05

## Context

ASVS 7.1.3 and 7.2.1 ask for authentication decisions to be logged where they
can be reviewed. Until M9, sign-in failures, locks and refused step-ups went to
the process log only. M0 left the reason in its known gaps
([M0-skeleton](../completed/M0-skeleton.md#known-gaps)): `audit_log` is keyed
on `brand_id`, a password change belongs to a person rather than a brand, and
the two obvious ways to write one were both wrong —

- **under whichever brand came first**, which puts a fact where it is not true
  and hides it from that brand's other admins' view of the other brands; and
- **under the install sentinel by the request's own staff principal**, which
  would mean an ordinary staff session opening an install-scope transaction —
  exactly what `target-brand.ts` exists to refuse.

A failed sign-in adds a third problem: it is reported by throwing, which rolls
the request back, and it may name no account at all.

## Decision

- Auth events are rows of `audit_log` under `INSTALL_SCOPE_BRAND_ID`, the same
  sentinel install-wide settings and brand deletion are recorded under. No new
  table, no migration: the viewer of M3-08 already reads them with
  `brand=install` and an `auth.*` action filter.
- They are written by the **`auth` system principal**
  (`AUTH_SYSTEM_PRINCIPAL`), the named system path sign-in already reads
  memberships through — never by the request's staff principal, which stays out
  of install scope.
- Each is written in **a transaction of its own**
  (`apps/api/src/auth/auth-audit.ts`), so a failure the request rolls back is
  still recorded. The request id, address and user agent come from the request
  context, which a `preHandler` hook fills (`context/client-facts.ts`).
- A write that fails is logged and swallowed: whether somebody can sign in must
  not depend on the audit table.
- What is recorded: `auth.sign_in.succeeded` and `.failed` (with the method and
  the reason, never the address typed), `auth.second_factor.failed` and
  `.replayed`, `auth.account.locked`, `auth.step_up.refused`,
  `auth.refresh_token.reused`, and every credential change —
  `auth.password.changed`, `.reset`, `auth.second_factor.enabled`, `.disabled`,
  `auth.recovery_codes.regenerated`, `auth.recovery_code.used`. Rate-limit
  refusals are counted by `rate_limit_refusals_total`, not audited row by row,
  so a flood cannot become a flood of rows.
- The actor is the account holder (`staff`) when they did it — a success, a
  change from inside their session — and `system`/`auth` when the api is
  reporting something done *to* the account by whoever was at the form.

## Consequences

- Install admins see every account's authentication history in one place, with
  the address and user agent each attempt came from. Brand admins do not:
  install scope is install admins' (DOMAIN-RULES §1.2).
- A credential change whose request fails *after* the row is written leaves a
  row for a change that did not commit. The services write the row only once
  the change itself is written, which narrows that to a failure in the last
  statements of a request.
- Install-scope rows are not purged by a brand's retention window; the audit
  log guide names this as a known gap until install-scope retention exists.

## Alternatives considered

- A separate `auth_events` table keyed on the user: a second audit viewer, a
  second retention rule and a new RLS shape for one kind of row.
- One row per brand the account works in: the same fact several times, and
  nowhere to put a failure that names no account.
