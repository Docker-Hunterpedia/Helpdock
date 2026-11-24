# M21 Customer portal

Status: planned (not started)
Owner: @Docker-Hunterpedia
Phase: 5 — 1.x. Proposed release: the next minor after the plan is accepted
Depends on: M1 (tickets, contacts, accounts), M2 (email, web form), M5 (help center pages and hosts), M18-10 (built-in CAPTCHA)
Effort: about 41 working days for one person, about 8 weeks (see Deliverables)
PRD: [Phase 5 · M21](../planning/PRD.md#m21-customer-portal)
Owner decisions: D-62 to D-67 in [decisions-1-x.md](../planning/decisions-1-x.md#m21-customer-portal)
ADRs (proposed): [0059](../decisions/0059-customer-sessions-by-emailed-link.md), [0060](../decisions/0060-account-wide-ticket-visibility.md)
Tracking issue: [#466](https://github.com/Docker-Hunterpedia/Helpdock/issues/466)

A customer signs in to a brand's help center with a link sent to their email,
sees their tickets on every channel, answers them and opens new ones. A
customer company can be set so its members see each other's tickets.

## Why a milestone of its own

The customer login portal was a v1 non-goal and then a backlog line
(REQUIREMENTS, Backlog: "magic-link login, ticket history, restricted KB"). It is
not polish of an existing surface (M19) and not a client (M20): it adds a
fourth kind of principal, a new session, new row-level-security policies and
the first pages where a customer reads ticket history. That is a security
boundary, so it gets its own plan, ADRs and negative tests.

The request that moved it (2026-11, a team comparing Helpdock with Freshdesk):
an employee of a client company could not see a coworker's tickets. The owner
decided on 2026-11-24 to plan it, with company-wide visibility as a setting per
account (D-62).

## Goal

A customer who has an email address on a ticket can, without a password and
without staff doing anything: sign in on the brand's help center, read every
public message of their tickets, reply, attach files, open a ticket and mark
one solved, in English or Arabic. Staff decide per customer company whether
its members see only their own tickets, all of the company's, or whether named
managers do.

## Scope

The [M21 section of the PRD](../planning/PRD.md#m21-customer-portal).

## Non-goals

- **Passwords, social sign-in and passkeys for customers.** One way in: the
  emailed link (ADR 0059). Signed widget identity (DOMAIN-RULES §4.2) stays a
  widget feature and does not sign anyone in to the portal.
- **A restricted knowledge base** (articles only signed-in customers read).
  It needs a third visibility and a third retrieval audience (DOMAIN-RULES §5)
  and is left for a follow-up (D-66).
- **Live updates.** Portal pages are rendered by the api like the rest of the
  help center (ADR 0015); a new reply shows on the next load. No socket.
- **Customers editing their company**, inviting coworkers, or choosing who is
  a manager. Staff do that.
- **Phone layouts below 600 px beyond what the help center already does**
  (M19).
- **Community forums, billing, order history.** Still non-goals for 1.x.

## What exists today

- **Help center pages** are rendered by the api as HTML under the brand's
  verified host or `/hc/<brandId>` (ARCHITECTURE §11, ADR 0015), with public
  pages cached and staff pages `private, no-store`.
- **Contacts and accounts** (`contacts`, `contact_identities`, `accounts`):
  an account is one customer company per brand; contacts carry an optional
  account and identities with a `verified` flag
  ([contacts guide](../guides/contacts.md)).
- **Tickets** carry `contact_id` and participants (DOMAIN-RULES §2.5), with
  row-level security by brand and department (§1.3).
- **Principals** are staff, visitor, API key and system (§1.1). A widget
  visitor reaches only conversations made with their `visitor_id` (§4.1).
- **Tokens sent to customers** are single-use, bound to one purpose and never
  grant more than that purpose (§4.6). A sign-in link is spent by a `POST`
  from the page it opens, never by the `GET`.
- **The web form** (M2) creates tickets from a public page, with the built-in
  proof-of-work CAPTCHA available (M18-10, ADR 0052).

## Deliverables

| Id | Deliverable | Spec | Days |
|---|---|---|---|
| M21-01 | Data model and policies: `customer_sessions`, `customer_sign_in_tokens`, account visibility, account role on a contact, `account_id` and `portal_private` on tickets, the `customer` principal and its row-level-security policies, with the negative tests | ADR 0059, 0060; DOMAIN-RULES §1, §4 | 6 |
| M21-02 | Sign-in: request a link, the email (en, ar), the confirm page that spends it by `POST`, the session cookie, sign out and sign out everywhere, rate limits and CAPTCHA | ADR 0059 | 5 |
| M21-03 | "My tickets": the list (open and solved, search by subject and reference) and the ticket page with public messages, attachments and customer-facing statuses | this plan | 5 |
| M21-04 | Acting on a ticket: reply with attachments, open a new ticket, mark solved, reopen under the brand's reopen policy, the satisfaction rating | DOMAIN-RULES §2.3, §4.5 | 5 |
| M21-05 | Company view: the "Mine / Company" filter, who opened each ticket, replying on a coworker's ticket, tickets staff marked private | ADR 0060 | 4 |
| M21-06 | Admin: the Customer portal settings page per brand, the visibility setting and managers on an account, portal access and sessions on a contact, "private to the requester" on a ticket, audit entries | this plan | 6 |
| M21-07 | Email and help center links: "View this ticket" in customer emails, "My tickets" and "Sign in" in the help center header | M2, M5 | 2 |
| M21-08 | Lifecycle: contact merge, erasure, retention, a changed or removed email identity, a contact moved between accounts, disabled brand | DOMAIN-RULES §4.4, §11 | 3 |
| M21-09 | Reports, webhooks and the public API: the `portal` channel value, `message.created` from the portal, nothing new exposed to API keys | M8 | 2 |
| M21-10 | Docs, guides, DOMAIN-RULES, pentest scope, the security review and the accessibility run | AGENTS.md DoD | 3 |

Total: 41 days.

## How it works

### Signing in (M21-02)

1. The customer opens **Sign in** on the help center and types an email
   address. The page always answers "If that address has tickets with us, we
   sent a link", whether or not it does (no way to test which addresses are
   customers).
2. If a contact of that brand has that address as an email identity (and the
   brand allows new customers, D-63, or the contact already exists), the outbox
   sends one email with a link valid for 15 minutes, single-use.
3. The link opens a page that names the brand and has one button, **Continue**.
   Pressing it spends the token by `POST` and sets the session cookie. Mail
   scanners that follow the link spend nothing (§4.6).
4. Spending the link marks that email identity **verified**: the customer has
   just proved they read mail at that address.
5. The session lasts 30 days, sliding, and is bound to the brand and to the
   help center host it was created on. **Sign out** ends it; **Sign out
   everywhere** ends all of that contact's sessions.

Limits: 5 link requests per address per hour and 20 per IP per hour, the same
answer when over the limit, and the proof-of-work CAPTCHA on the form when the
brand has it on for the web form.

### What a customer sees (M21-03)

- Tickets where they are the **requester** or a **participant** (a Cc that
  matches one of their verified email identities), on every channel: email,
  web form, widget, Telegram, WhatsApp, Messenger, Instagram.
- Of each ticket: subject, reference, a customer-facing status, the public
  messages in order with who wrote them (staff as DOMAIN-RULES §2.10 shows an
  agent to a customer), and attachments through the existing short-lived
  authorised URLs (§4.5).
- **Never:** internal notes, activity, tags, priority, SLA, assignee beyond
  the name §2.10 allows, AI drafts, routing, custom fields, merged-away or deleted
  tickets, spam.
- Statuses map to four words: **Open**, **Waiting for you** (awaiting
  customer), **Solved** (closed), and **Waiting for us** for anything else
  that is not closed. Snoozed reads as Waiting for us.

### What a customer does (M21-04)

- **Reply.** Stored as a public inbound message on the channel value
  `portal`, written by the contact, so reopen policy, SLA clocks, rules,
  notifications and webhooks treat it exactly like an emailed reply.
- **New ticket.** The brand's web form fields and departments, minus the
  email field, already known.
- **Mark solved** on their own ticket, and reply to reopen where the brand's
  reopen policy allows (§2.3); otherwise the page offers a new ticket that
  links to the old one, as an emailed reply to a closed ticket does today.
- **Rate** a solved ticket when the brand asks for ratings.

Uploads follow the existing rules: MIME sniffed, images re-encoded, sizes
capped by the brand's content policy.

### Company view (M21-05, ADR 0060)

An account has one of three settings, chosen by staff, **own tickets** by
default:

| Setting | Who sees the account's tickets |
|---|---|
| Own tickets | Each member sees only tickets they requested or are a participant of |
| Managers | Members marked **manager** see all of the account's tickets; the rest see their own |
| All members | Every member sees all of the account's tickets |

- "The account's tickets" are tickets whose requester belongs to that account
  **now** (a ticket follows its requester when staff move the contact to
  another account).
- A member who sees a coworker's ticket may read it and, if D-64 says so,
  reply; replying adds them as a participant.
- Staff can mark one ticket **private to the requester**. It then shows only
  to its requester and participants whatever the account's setting (an HR or
  payroll question).
- Membership counts only for a contact who signed in with a **verified**
  email identity, and an account's email domain never adds anyone by itself:
  staff put contacts in accounts, as today.

### Staff side (M21-06)

- **Settings › Channels › Customer portal** per brand: on or off (off by
  default), who may sign in (D-63), which departments' tickets are shown
  (D-65), and the sign-in email's wording through the existing templates.
- **Account page:** the visibility setting and the manager mark per member.
- **Contact page:** whether the contact has signed in, when, a list of
  sessions and **Sign out everywhere**.
- **Ticket details:** "Private to the requester".
- Every change of these is audited. A customer's sign-in, sign-out and failed
  link are security events, not audit rows, to keep the audit log readable.

## Data model

All new tables are tenant tables: `brand_id`, `FORCE`d row-level security, and
a place in the isolation test.

- **`customer_sessions`**: id, brand, contact, the email identity used, a
  SHA-256 of the session token, created, last seen, expires, user agent
  family, and the help center host. Token shown once in the cookie.
- **`customer_sign_in_tokens`**: id, brand, the email as typed (lower-cased),
  contact or null, a SHA-256 of the token, expires, spent at. Rows for
  unknown addresses are not created.
- **`accounts.portal_visibility`**: `own | managers | all`, default `own`.
- **`contacts.account_role`**: `member | manager`, default `member`.
- **`tickets.account_id`**: the requester's account, kept by trigger when the
  ticket's contact or the contact's account changes, so the policy needs no
  join (the pattern `department_id` on child tables already uses, §1.3).
- **`tickets.portal_private`**: boolean, default false.
- **Brand settings** gain `portal: { enabled, newCustomers, departments }`.

## Security and privacy

- **A fourth principal** (DOMAIN-RULES §1.1):
  `{ type: 'customer'; id: contactId; brandId; accountId?: uuid; sees: 'own' | 'account' }`.
  It is set only by the portal's own guard from a valid session, and its
  routes are the portal's only: a customer session is refused on every admin,
  widget and API-key route, and the reverse.
- **Row-level security does the work** (ADR 0060). For the `customer`
  principal a restrictive policy on `tickets` and its child tables allows a
  row only when the customer is the requester, or a participant, or
  (`sees = 'account'` and the ticket's `account_id` is theirs and it is not
  `portal_private`), and the ticket's department is one the brand shows. On
  `ticket_messages` it also requires `public`. Output schemas for the portal
  have no field for notes, as visitor schemas do not (§1.3 layer 4).
- **The session** is an opaque 256-bit token in a `__Host-` cookie:
  `HttpOnly; Secure; SameSite=Lax; Path=/`, stored hashed. State-changing
  requests also carry a CSRF token tied to the session. Portal pages are
  `Cache-Control: private, no-store` and never enter the Redis render cache
  (§5).
- **No enumeration:** one answer and one timing for known and unknown
  addresses; the email is sent through the outbox after the response.
- **Revocation:** sessions end when the email identity used is removed or
  unverified, when contacts merge (the loser's sessions end; the survivor's
  stay), on erasure (§11), when the brand turns the portal off, and on "Sign
  out everywhere" by the customer or by staff.
- **What the link proves:** control of one mailbox at one moment. It is never
  accepted from a `GET`, never logged, expires in 15 minutes, and a second
  request does not cancel the first (so nobody can lock a customer out by
  requesting links).
- **Abuse:** the portal reuses the web form's limits for new tickets and
  replies, and the upload pipeline's scanning.
- **Privacy:** company-wide visibility shows a person's support history to
  coworkers. It is off by default, set by staff per account, named plainly in
  the admin copy, and the portal tells a member when their tickets are visible
  to their company.
- **Negative tests** (DOMAIN-RULES §1.6 gains a customer section): brand A's
  customer and brand B's tickets; a member and a coworker's ticket under each
  of the three settings; a private ticket; a note; a hidden department; a
  spent, expired and foreign-brand link; a session on another brand's host; a
  customer token on staff and widget routes.

## Design artboards

Drawn on the design canvas before any screen is built, each in `en` and `ar`:

| Artboard | Shows |
|---|---|
| `HelpCenter/Portal-SignIn` | The email form, the "check your email" answer, the Continue page, expired and spent links, the rate-limit answer |
| `Email/Portal-SignIn` | The sign-in email |
| `HelpCenter/Portal-Tickets` | The list: Mine and Company, open and solved, search, empty states, the notice that the company can see your tickets |
| `HelpCenter/Portal-Ticket` | A ticket: messages, attachments, reply, mark solved, closed past the reopen window, a coworker's ticket |
| `HelpCenter/Portal-NewTicket` | The new-ticket form and its errors |
| `HelpCenter/Portal-Header` | "My tickets", "Sign in" and the signed-in menu in the help center header |
| `Admin/Channels-CustomerPortal` | The settings page |
| `Admin/Account-PortalVisibility` | The visibility setting and managers on an account |
| `Admin/Contact-PortalAccess` | Portal access and sessions on a contact; "Private to the requester" on a ticket |

## Tests

- **Unit:** token and session lifetimes, the status mapping, the visibility
  rule as a pure function over (setting, role, requester, participant,
  private), email template rendering in both locales.
- **Integration (Testcontainers):** the sign-in flow end to end, every
  negative test above against real row-level security, the trigger that keeps
  `tickets.account_id`, merge, erasure and retention, a portal reply driving
  reopen, SLA and rules like an emailed one.
- **Playwright** (`apps/helpcenter/e2e` or where the help center specs live),
  `en` and `ar`: sign in, read, reply with an attachment, new ticket, mark
  solved, company view under each setting, the failure paths (expired link,
  rate limit, a ticket that is not yours answers 404).
- **Security:** the `security-audit` skill on M21-01, M21-02 and M21-05, and
  the portal's sign-in pages added to the ZAP baseline.

## Docs

A customer portal guide for operators and one page for customers' own help;
the contacts, accounts, help-center, email and security-scanning guides;
DOMAIN-RULES §1.1, §1.3, §1.6, §4 (a new §4.9 "Customer sessions"), §5 and
§11; ARCHITECTURE §5 and §7; `pentest-scope.md`; REQUIREMENTS §4 and the
backlog line; `.env.example` if a key is added (none planned).

## ADRs

- [0059](../decisions/0059-customer-sessions-by-emailed-link.md): customers
  sign in by an emailed link to a host-bound session; no passwords.
- [0060](../decisions/0060-account-wide-ticket-visibility.md): company-wide
  visibility is a setting per account enforced by row-level security on a
  denormalised `account_id`.

## Risks

- **A leak across customers** is the worst outcome a helpdesk can have. The
  mitigation is that the policy, not the page, decides, and that every case
  has a negative test before a screen exists (M21-01 ships first and alone).
- **Forwarded mail.** Whoever holds a sign-in email within 15 minutes can sign
  in. That is the same trust email-based support already has; the guide says
  so, and the link names the brand and the address.
- **Shared mailboxes** (`support@client.com`) make everyone behind them one
  customer. Expected; documented.
- **Wrong account membership** set by staff or an import shows tickets to the
  wrong company. The default `own`, the plain copy on the setting and the
  private mark limit it.
- **The trigger on `tickets.account_id`** adds a write per contact move. Moves
  are rare; the integration test measures it at 50k tickets.

## Open questions

D-62 to D-67 in [decisions-1-x.md](../planning/decisions-1-x.md#m21-customer-portal).

## Build order

1. M21-01 alone, reviewed with the security skill, before anything renders.
2. M21-02, then M21-03 and M21-04.
3. M21-06 (admin) alongside M21-05 (company view), which needs its settings.
4. M21-07, M21-08, M21-09.
5. M21-10, the security review and the accessibility run, then release.

## Exit criteria

- [ ] A customer signs in with an emailed link, reads, replies with an
      attachment, opens a ticket and marks one solved, in `en` and `ar`.
- [ ] Under each of the three account settings a member sees exactly the
      tickets the table above says, and a private ticket only its requester's.
- [ ] Every negative test passes against real row-level security, and no
      portal response contains an internal note.
- [ ] Known and unknown addresses get the same answer; a link works once, for
      15 minutes, and only by `POST`.
- [ ] Merge, erasure, retention and a removed email identity end the sessions
      they should.
- [ ] The guides, DOMAIN-RULES and the pentest scope describe what was built.
