# Staff and roles

Who works in a brand, what each role may do, and what happens when somebody is
invited, changed, deactivated or deleted. Specified by [REQUIREMENTS
§2](../planning/REQUIREMENTS.md) and [DOMAIN-RULES §1.2 and
§12](../planning/DOMAIN-RULES.md#12-scope-rules). Implemented by M0-06.

Signing in is [the authentication guide](authentication.md). This guide is about
what an account is allowed to do once it has.

## The four roles

A staff member has **one role per brand**. Somebody can be an Admin of one brand
and an Agent of another; the two are unrelated.

| Role | Sees tickets | Edits tickets | Manages configuration |
|---|---|---|---|
| **Admin** | The whole brand | Yes | Everything in the brand |
| **Team Leader** | Their departments | Yes | Their departments: agents, SLAs, rules, macros, canned responses, help center, widget theme |
| **Agent** | Their departments only | Tickets in their departments | Nothing |
| **Viewer** | Their departments | No | Nothing; reads reports and help center content |

An **install admin** is a separate flag, not a role. It is the only principal
that may run all-brands paths, and it does **not** inherit a role in any brand —
an install admin reaches a brand's data by being given a role in it.

### Departments

Departments are created, named, ordered and given teams on **Admin → Ticketing**
(M1-01) — see [ticketing settings](ticketing-settings.md). This page is where
they are *assigned*, and the rule that decides what an assignment means is:

| Role | An empty department list means |
|---|---|
| Admin | Every department, whatever was chosen |
| Team Leader, Viewer | Every department — the unrestricted case of DOMAIN-RULES §1.1 |
| Agent | **No** departments, so the account sees no tickets until one is added |

The last row is deliberate. An Agent with nothing assigned must see nothing;
reading their empty list as "everything" would be the one mistake that hands a
new starter the whole brand.

**Teams are narrower than departments, and follow from them.** A department
holds teams, and a team holds people (M1-01). Somebody may only be put on a team
whose department their own scope already reaches, so a team can never contain
somebody who cannot see the tickets it would be assigned. Changing a person's
departments here therefore changes which teams they may be added to; it does not
remove them from a team they are already on, but the team lists stop showing
anybody who has lost their role in the brand.

**Team membership follows the same ceiling as a role change.** A Team Leader
adds and removes Agents and Viewers; an Admin, another Team Leader, or the Team
Leader themselves go on a team only when an Admin puts them there — the same
line this page draws for who may change whose role. See
[ticketing settings](ticketing-settings.md#teams).

### Attempts, and what is rate-limited

| Bucket | Limit |
|---|---|
| Reading or accepting an invitation, per IP | 30 per 15 minutes |
| An invitation sent to one address, across invite and resend | 5 per 15 minutes |
| Re-proving a credential from inside a session — the current password, and a live code before the second factor is weakened — per account | 5 per 15 minutes |

The last one matters more than it looks. Signing in spends a challenge with
three attempts and a fifteen-minute lock; the security page has no challenge to
spend, and six digits with a one-step window is three valid codes out of a
million at any instant. Without a budget, turning somebody's second factor off
from an unlocked laptop would be minutes of guessing.

### The Viewer toggle

`roles.viewerEnabled` is an install setting (default on). Turning it **off**:

- refuses any invitation or role change that would make somebody a Viewer, with
  the reason `viewer-disabled`;
- treats an existing Viewer as holding **no role**. Their Viewer membership is
  dropped when a session is built, so an account whose only role was Viewer can
  no longer sign in and is answered `no-account`. The rows are not deleted —
  turning the setting back on restores them exactly.

## What a Team Leader may do

A Team Leader holds `staff:manage`, so they reach the staff screen. Inside it
they may manage **agents and viewers whose departments are a subset of their
own**, and nothing else:

- not another Team Leader, and not an Admin;
- not an agent of a department they do not lead — in either direction, so they
  can neither reach outside their scope nor move somebody into it;
- not a role above their own: they cannot hand out Admin or Team Leader;
- not an address that already has an account on this install. Inviting somebody
  nobody here knows creates a new account; attaching an account that exists
  elsewhere is an Admin's decision, for the reason below.
- not **deactivation**, in either direction. That is the one action whose effect
  leaves the brand.

Anything else answers `403` with the reason `out-of-scope`.

### Why two of those are an Admin's decision

`users` is a global table, so an address resolves across every brand on the
install. Two of the actions here are therefore not confined to the brand they
are performed in:

- **Attaching an existing account.** Adding a role to somebody else's account
  and then acting on it is how a brand-scoped permission would reach out of its
  brand. An Admin may do it — being an Admin of a brand is already the authority
  to decide who works in it — and an **install admin's account is never
  adoptable by anybody**.
- **Deactivation.** It decides whether somebody may sign in to the install at
  all, not only to this brand, so it takes the brand's highest standing. The
  brand-scoped half of the same idea is *removal from one brand*, which a Team
  Leader may do within their scope.

## Two rules that apply to everybody

- **Nobody changes or deactivates their own role.** An administrator who demotes
  themselves by accident leaves a brand with no administrator and no way back.
  Refused with `409` and the reason `self`.
- **The last install admin keeps its access.** A session is only ever minted for
  an account that holds a brand role, so there are three ways to lock the
  operator out of their own install and all three are refused with `409` and the
  reason `last-install-admin`: deactivating them, taking their role in this
  brand away, and demoting them to Viewer (which the install toggle could then
  switch off). An install admin who is still `invited` counts towards the floor —
  their account works the moment they accept.

## Inviting somebody

An Admin or a Team Leader opens **Staff and roles → Invite**, types an address,
picks a role and any departments, and sends it.

What happens:

1. A `users` row with `status: invited` is created if the address is new. If it
   already belongs to an account, that account is reused and gains a role in
   this brand.
2. A `user_brand_roles` row records the role and departments.
3. For an account that has never signed in, a single-use token good for **seven
   days** is issued and emailed as `<APP_URL>/invite/<token>`. See *An address
   that already has an account* below for the other case.
4. An `audit_log` row records `staff.invited`.

The invited person appears in the list straight away as a pending invitation,
with when it was sent and when it lapses.

### Accepting

`/invite/<token>` is public: the token is the credential. Opening the link
**reads** the invitation without spending it, so a refresh costs nothing. The
form asks for a name, a password of at least twelve characters and a language;
submitting it spends the token, activates the account, writes
`staff.invite.accepted` and signs the person in. If the install requires
two-factor, they land on enrolment first.

An expired, revoked or already-accepted link answers `410` and the screen says
so. All three read the same from outside, so a stale link cannot be used to find
out whether an address still works here.

### Resending and revoking

- **Resend** issues a new token and **destroys the previous one** in the same
  breath, so there is never more than one live invitation per person.
- **Revoke** deletes the pending role and the token. If the account held no
  other role and had never signed in, the account row goes with it.

### An address that already has an account

Inviting somebody who already works here — in another brand, say — adds the role
and **sends nothing**. They already have a password, and a link that could set a
new one would be a way to take over an existing account with an invitation. They
appear in the list as active straight away and reach the new brand with the
credentials they already use.

A pending invitation in another brand is different: that account has never been
used, so it gets an invitation for this brand too.

## Changing somebody

| Action | Effect |
|---|---|
| **Change role or departments** | Every refresh token family is revoked, so the next access token carries the new claims within the ten minutes DOMAIN-RULES §1.6 allows. `principal.revoked` is published, which M0-13's gateway turns into a socket disconnect. An `assignment.access_changed` outbox row is written in the same transaction; the worker unassigns every open ticket the person can no longer work and applies each department's `on_unassign` (M1-07). A widened scope unassigns nothing. |
| **Deactivate** | Sessions and trusted devices revoked, socket disconnect announced, removed from presence (M0-13); the rotation never picks a deactivated account (M1-07), and their open tickets in this brand are unassigned and handled per `on_unassign`. Notifications stop. Reversible with **Reactivate**. |
| **Remove from this brand** | The role in this brand goes and every session ends; their open tickets here are unassigned per `on_unassign`, as for a deactivation. Roles in other brands are untouched. |
| **Delete** | Install-admin only, and only after deactivation. See below. |

**Deactivation is an account-level state**, as DOMAIN-RULES §12 defines it: a
deactivated person cannot sign in to any brand, not only the one it was done
from. The brand-scoped half of that table row is *removal from one brand*. The
audit row records which brand the deactivation was performed from.

### Deleting an account

`DELETE /api/install/staff/:userId`, for an install admin, on an account that is
already deactivated. The row is **kept** and everything personal about it is
replaced:

| Column | Becomes |
|---|---|
| `name` | `Former staff` |
| `email` | `former-staff+<32 hex>@deleted.invalid`, derived from the user id |
| `password_hash`, `totp_secret_encrypted`, `recovery_codes_hashed` | Empty |
| `install_admin` | False |

The row survives because things point at it: audit rows name the actor, and from
M1 a ticket names who replied. The placeholder address is unique so the
case-insensitive index on `email` still holds, and is derived from the user id
rather than from the old address, so holding one proves nothing about who it
used to be.

The person's `user_brand_roles` rows are **not** removed: they live in a tenant
table, which an install-scope transaction cannot see, and widening that scope is
the one thing install scope exists to make deliberate. Each brand's own
administrator removes the "Former staff" row with the brand-scoped action.

## Two-factor enrolment

`/sign-in/enrol` is where an install with `auth.require2fa` on sends an account
without an authenticator, and where **Turn on two-factor** on the security page
leads.

1. **Scan.** The screen stages a secret and draws it as a QR code, with the same
   key in text for a machine with no camera and the account and issuer named
   underneath. Nothing is enabled yet, so a scan that did not save cannot lock
   anybody out.
2. **Save the codes.** A live code turns the second factor on and hands over ten
   recovery codes, once. They can be downloaded or copied, and **Continue** stays
   disabled until the checkbox says they are saved — the one screen where an
   extra click is worth it.

The QR code is drawn in the browser, as SVG, by a small encoder in
`apps/admin/src/ui/qr-encode.ts`. It is not fetched from anywhere: the
`otpauth://` URI is a credential, and asking a server to draw it would put it in
a second place.

## Your own account

**Security** in the account menu, at `/me/security`:

| Card | |
|---|---|
| Your details | Name and interface language. The sign-in address is read-only; an administrator changes it. |
| Password | Current password, then a new one of at least twelve characters. Changing it signs out **every other** browser and forgets every browser this account trusted. |
| Two-factor | Status, how many recovery codes are left, and — unless the install requires it — turning it off. Turning it off and redrawing the codes each ask for a live authenticator code, because a session proves somebody signed in, not that the person at the keyboard now is the account holder. |
| Active sessions | Every browser this account is signed in on, with the current one marked. Sign one out, or sign out everywhere. |

These write no `audit_log` row. `audit_log` is keyed on `brand_id`, and a
password change belongs to a person rather than to a brand; writing it under
whichever brand happened to be first would put a fact somewhere it is not true,
and writing it under the install sentinel would mean an ordinary staff principal
opening an install-scope transaction. They are written to the process log
instead, with the user id and the reason.

## Endpoints

| Route | Declaration | |
|---|---|---|
| `GET /api/brands/:brandId/departments` | `@Requires('brand:read')` | The chip picker's options. Owned by M1-01; see [ticketing settings](ticketing-settings.md#endpoints) |
| `GET /api/brands/:brandId/staff` | `@Requires('staff:manage')` | The list, with `?search=` |
| `POST /api/brands/:brandId/staff/invites` | `@Requires('staff:manage')` | Invite an address |
| `POST /api/brands/:brandId/staff/invites/:userId/resend` | `@Requires('staff:manage')` | New token, old one destroyed |
| `DELETE /api/brands/:brandId/staff/invites/:userId` | `@Requires('staff:manage')` | Revoke |
| `PATCH /api/brands/:brandId/staff/:userId` | `@Requires('staff:manage')` | Role and departments |
| `POST /api/brands/:brandId/staff/:userId/deactivate` | `@Requires('staff:manage')` | |
| `POST /api/brands/:brandId/staff/:userId/reactivate` | `@Requires('staff:manage')` | |
| `DELETE /api/brands/:brandId/staff/:userId/role` | `@Requires('staff:manage')` | Remove from this brand |
| `DELETE /api/install/staff/:userId` | `@Requires('install:admin')` | Delete and anonymise. Audited |
| `GET /api/auth/invites/:token` | `@Public()` | Read an invitation. Rate-limited |
| `POST /api/auth/invites/:token/accept` | `@Public()` | Spend it. Rate-limited |
| `GET /api/me/profile` | `@Authenticated()` | |
| `PATCH /api/me/profile` | `@Authenticated()` | Name and language |
| `POST /api/me/password` | `@Authenticated()` | Current plus new |
| `POST /api/me/totp/disable` | `@Authenticated()` | A live code. Refused while `auth.require2fa` is on |
| `POST /api/me/recovery-codes/regenerate` | `@Authenticated()` | A live code |
| `GET /api/me/sessions` | `@Authenticated()` | |
| `DELETE /api/me/sessions/:family` | `@Authenticated()` | |

A refused staff action answers the usual error body with one extra field:

```json
{
  "error": {
    "code": "conflict",
    "message": "You cannot change or deactivate your own role",
    "requestId": "0199f4b2-…",
    "staff": { "reason": "self" }
  }
}
```

`error.staff.reason` is one of `self`, `out-of-scope`, `viewer-disabled` or
`last-install-admin`. The admin turns it into a translated sentence; no
user-facing English crosses that boundary.

## Settings

| Key | Default | |
|---|---|---|
| `roles.viewerEnabled` | `true` | Whether the read-only Viewer role can be assigned |
| `auth.require2fa` | `false` | Sends a new account to enrolment, and stops anybody turning the second factor off |

No new `.env` key.

## Sending

The invitation goes out through the same seam as the sign-in link and the
password reset: `EmailSender` in
[`packages/channels`](../../packages/channels/src/email/sender.ts). Until M2
brings SMTP, the development sender writes one line to the log — the recipient,
the subject and the locale, never the body, because an invitation's body
contains a working credential.

Like the other two, it is a documented exception to the outbox rule of
DOMAIN-RULES §6: it is not a domain change, and it is useless the moment its
Redis token expires.

## Tests

| | |
|---|---|
| `pnpm --filter @helpdock/api test` | The permission matrix, the anonymisation, the invite store |
| `pnpm test:integration` | The whole of §12 over HTTP against a real Postgres and Redis |
| `pnpm --filter @helpdock/admin test` | The screens and the fixture |
| `pnpm --filter @helpdock/admin e2e` | The screens in a browser, in `en` and `ar`, with axe |
| `pnpm --filter @helpdock/admin e2e:api` | Invite → accept → enrol → sign in, against a real api |

## Known gaps

- **A department has no business hours or SLA policy yet.** Business hours and
  the SLA policy are M3. `on_unassign` is M1-07's
  ([Assignment](ticketing-settings.md#assignment)).
- **Deactivation unassigns in one brand.** The hook fires for the brand the
  action was taken in; an account deactivated there keeps its tickets in other
  brands assigned until somebody moves them, though the rotation never picks it
  anywhere.
- **API keys created by a deactivated person are not revoked.** API keys arrive
  with M8.
- **A Team Leader reads the whole brand's roster**, not only their own
  departments: `user_brand_roles` is brand-scoped, not department-scoped, and
  DOMAIN-RULES §1.2 does not narrow reading the list. They can act on their own
  departments alone — including on the Ticketing screen, where they may edit
  only the departments they lead. Narrowing the *read* is still a product
  decision nobody has taken.
- **An account added to a second brand is not emailed about it.** The role is
  created and nothing is sent; there is no "you were added to a brand" message
  until M2 brings a real transport and a template for it.
