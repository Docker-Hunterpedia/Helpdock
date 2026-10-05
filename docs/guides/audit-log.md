# Audit log

**Admin → System → Audit log · Open** (`/admin/system/audit-log`, deliverable
M3-08) shows who changed what across the whole install, newest first. It is
read-only; retention removes rows after each brand's audit window (two years by
default, never under 90 days, DOMAIN-RULES §11).

## Sign-ins and credential changes

Every authentication decision — sign-ins that succeeded or failed, locks,
refused step-ups, replayed codes, reused refresh tokens, and every change to a
password, second factor or recovery codes — is an `auth.*` row in install
scope (**Brand: install**), written by the `auth` system principal with the
client address and user agent. [Authentication › The audit
trail](authentication.md#the-audit-trail) lists them.

## Who may read it

Install admins only. The route is `GET /api/install/audit-log`, declared
`install:admin`, so it runs in install scope and writes its own
`install.scope.access` row before answering. The transaction is then widened to
every brand (`widenInstallScope` in `apps/api/src/tenant/install-scope.ts`),
which refuses to run from anything but an install-scope transaction.

## Filters and paging

| Query | Meaning |
|---|---|
| `actor` | A staff member's name or email, or an actor id, matched loosely |
| `action` | An exact action, or a family such as `ticket.*` |
| `targetType` | `settings`, `ticket`, `contact`, `user` (staff), `macro`, `tag`, … |
| `brand` | A brand id, or `install` for install-wide rows |
| `from`, `to` | ISO timestamps; the page sends whole local days |
| `cursor` | `nextCursor` of the previous page |
| `limit` | 1 to 100, default 50 |

## What each row shows

Time, actor, action, target, brand and the client IP. Expanding a row shows the
request id, how the change was made (admin UI, API, worker) with a
browser-and-system summary of the user agent, and a before/after table of the
fields that moved.

**Secrets are never returned.** The api reads each row's `meta` into
`changes` and `details` (`apps/api/src/audit/audit-diff.ts`) and replaces every
value whose name looks like a credential, or that is a setting the registry
marks secret, with `[redacted]` on both sides.

## Where the request columns come from

`audit_log` has `ip`, `request_id` and `user_agent` columns (migration 0028).
Their defaults read `app.request_ip`, `app.request_id` and
`app.request_user_agent`, which the tenant interceptor sets on every request
transaction next to the RLS settings. So every writer fills them without
passing anything, and rows written by a worker are null. The address is
`request.ip` as Fastify resolves it under `TRUST_PROXY`, and is dropped unless
it parses as an IP. The auth trail, written outside the request transaction,
passes the same three facts itself, from the request context.

## Known gaps

- **Install-scope rows have no retention window.** Retention purges each
  brand's rows after its audit window; rows under the install sentinel —
  install-wide settings, brand deletion and the `auth.*` trail — are kept until
  an install-scope retention setting exists. The sign-in rate limits bound how
  fast failed sign-ins can add rows.
