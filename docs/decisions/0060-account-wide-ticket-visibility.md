# 0060 Company-wide ticket visibility is a setting per account, enforced by row-level security

Status: accepted (owner decision D-62, 2026-11-24)
Date: 2026-11-24

## Context

The request behind [M21 Customer portal](../in-development/M21-customer-portal.md)
was that an employee of a client company should see their coworkers' tickets.
Helpdock already models the company: an `accounts` row per customer company
per brand, and an optional account on each contact
([contacts guide](../guides/contacts.md)).

Showing one person's support history to coworkers is a privacy decision, and
it differs by customer: an agency wants the whole team to follow every
ticket, while a large client wants only its IT lead to. Some tickets (payroll,
HR, a complaint about a colleague) must stay with their requester whatever the
company's choice.

Tickets are protected by row-level security on brand and department, with the
rule that policies never join: child tables carry a denormalised
`department_id` kept by trigger (DOMAIN-RULES §1.3).

## Decision

1. **`accounts.portal_visibility`** is `own` (default), `managers` or `all`.
   Staff with permission to edit accounts set it.
2. **`contacts.account_role`** is `member` (default) or `manager`. It matters
   only under `managers`.
3. **"The account's tickets"** are those whose requester is in the account
   now. `tickets.account_id` holds that, kept by trigger when a ticket's
   contact changes and when a contact's account changes.
4. **`tickets.portal_private`** hides one ticket from the company view. Its
   requester and participants still see it.
5. **The `customer` principal** carries `sees: 'own' | 'account'`, computed at
   sign-in and on every request from the account's setting and the contact's
   role, so a change takes effect on the next request.
6. **A restrictive row-level-security policy** for that principal on
   `tickets` and its child tables allows a row only when the customer is the
   requester or a participant, or when `sees = 'account'`, the ticket's
   `account_id` equals theirs and it is not private. Messages must also be
   public. The portal's queries add the same conditions for the planner; the
   policy is what is trusted.
7. **Membership is what staff recorded.** An account's email domain never
   grants company visibility by itself, and only a contact who signed in with
   a verified email identity is treated as a member.
8. **The portal tells a member** when their tickets are visible to their
   company.

## Consequences

- The default changes nothing for existing accounts: everyone sees only their
  own tickets until staff choose otherwise.
- The policy has no join, so the planner can use
  `(brand_id, account_id)` like it uses `(brand_id, contact_id)`.
- One more denormalised column and trigger on `tickets`, and a rewrite of a
  contact's tickets when the contact moves account. Moves are rare; the
  integration test measures one at 50k tickets.
- A ticket "follows" its requester to a new account. History therefore moves
  with the person, which matches what staff see on the account page today.
- Wrong membership (a manual mistake or an import) exposes tickets to the
  wrong company. The default, the private mark and plain copy on the setting
  limit it; the audit log records who changed the setting and the roles.

## Alternatives considered

- **Everyone in an account sees everything.** Simplest, and wrong for
  sensitive tickets and for large customers. Rejected by D-62.
- **Per-ticket sharing chosen by the customer** ("share with my company").
  Puts the privacy choice with the person, but the request was that coworkers
  see tickets without anyone remembering to share them. The private mark
  covers the opposite case from the staff side; a customer-side private mark
  can follow.
- **Deciding visibility in the application, not in a policy.** One missed
  `WHERE` leaks a company's tickets. Every other tenant boundary in Helpdock
  is a policy; this one is too.
- **Membership by email domain.** `gmail.com` and shared domains make it
  unsafe, and a domain proves nothing about employment.
