# 0059 Customers sign in by an emailed link to a host-bound session

Status: proposed
Date: 2026-11-24

## Context

[M21 Customer portal](../in-development/M21-customer-portal.md) lets a customer
read and answer their tickets on a brand's help center. Until now nobody
outside staff has a session: a widget visitor holds a secret for the
conversations their browser started (DOMAIN-RULES §4.1), and every token
mailed to a customer opens exactly one thing (§4.6). The portal needs a
customer to prove who they are well enough to read ticket history on every
channel.

Constraints:

- Customers reach Helpdock by email, and most never chose a password with the
  brand. A password adds reset mail, breach handling and a second credential
  store for people who visit twice a year.
- A brand's help center runs on its own host, or under `/hc/<brandId>` on the
  install's host (ARCHITECTURE §11). Several brands share one install.
- Mail scanners and link previews follow every link in a message (§4.6).
- The answer to "is this address a customer" is itself private.

## Decision

1. **One way in: a link sent to an email address.** No customer passwords,
   social sign-in or passkeys in M21.
2. **The link** is single-use, valid for 15 minutes and bound to one brand and
   one address. Opening it shows a page with one button; the token is spent by
   the `POST` that button sends, never by the `GET`. Only a SHA-256 of the
   token is stored (`customer_sign_in_tokens`).
3. **Requesting a link** always gives the same answer and takes the same time,
   whether or not the address belongs to a contact. The email goes through the
   outbox after the response. Limits: 5 requests per address and 20 per IP per
   hour. A new request does not cancel an earlier link.
4. **Spending a link verifies that email identity** of the contact.
5. **The session** is an opaque 256-bit token in a `__Host-` cookie
   (`HttpOnly; Secure; SameSite=Lax; Path=/`), stored hashed in the tenant
   table `customer_sessions`, 30 days sliding, bound to the brand and to the
   help center host it was issued on. Under `/hc/<brandId>` on a shared host
   the cookie name carries the brand id, and the guard still checks the
   session's brand against the path.
6. **A new principal** `customer` (DOMAIN-RULES §1.1) is set only by the
   portal's guard. Staff, visitor and API-key routes refuse it, and portal
   routes refuse the others.
7. **State-changing portal requests** carry a CSRF token tied to the session,
   and every portal page is `Cache-Control: private, no-store`.
8. **Sessions end** on sign out, sign out everywhere (by the customer or by
   staff), removal or loss of verification of the email identity used, contact
   merge (the merged-away contact's sessions), erasure, and when the brand
   turns the portal off.

## Consequences

- Nothing to remember and nothing to reset; the mailbox is the credential, as
  it already is for email support.
- Whoever can read a customer's mail within 15 minutes can sign in as them.
  That is the trust email support already rests on; the guide states it.
- A customer signs in once per brand and per host. Two brands of one install
  are two sign-ins, which matches how they appear to customers.
- The staff auth stack (JWT access token, rotating refresh family) is not
  reused. An opaque server-side session is simpler to revoke and has no
  token for page scripts to hold; portal pages are server-rendered.
- A second session store and guard to maintain and to test.

## Alternatives considered

- **Passwords for customers.** More to build and to defend, for accounts used
  rarely. Rejected for M21; nothing here prevents adding them later.
- **Signed widget identity as the sign-in** (§4.2). It proves what the brand's
  own site says about its user, only for brands that integrated it, and it is
  not a session. It stays a widget feature.
- **A token in every ticket email that opens the ticket.** Convenient, but a
  forwarded email would hand over the ticket, and §4.6 forbids tokens that
  grant more than their purpose. Emails link to the portal, which asks for
  sign-in.
- **Reusing the staff session.** It would put customers and staff in one
  credential space and one cookie scope on installs where the help center
  shares the admin host. Rejected.
