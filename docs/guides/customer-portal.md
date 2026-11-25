# Customer portal

The customer portal lets a customer sign in to a brand's help center and, in later releases, read and answer their tickets there. This guide covers what exists after **M21-02**: signing in and out. The ticket list and ticket pages arrive with M21-03 and M21-04, and the admin screens with M21-06. The plan is [M21 Customer portal](../in-development/M21-customer-portal.md); the decision is [ADR 0059](../decisions/0059-customer-sessions-by-emailed-link.md).

## What it is

A customer opens **Sign in** on the brand's help center, types the email address they write to the brand from, and receives a link. Pressing **Continue** on the page that link opens signs them in for 30 days. There is no password: the mailbox is the credential, as it already is for email support.

Whoever can read the customer's mail within 15 minutes can sign in as them. A forwarded sign-in email works for whoever holds it, and a shared mailbox such as `support@client.com` makes everyone behind it one customer. This is the trust email support already rests on, and the email names the address and says what to do if nobody asked for it.

## Turning it on

The portal is off for every brand. Until the admin page arrives (M21-06) it is a brand setting, `brands.settings.portal`:

```json
{ "portal": { "enabled": true, "newCustomers": false, "departmentIds": "all" } }
```

| Key | Meaning |
|---|---|
| `enabled` | The portal exists for this brand. With it off, every portal address answers the help center's own 404 and the header shows nothing new. |
| `newCustomers` | An address with no contact may sign in too, and the first Continue creates the contact with that address as a verified email identity. Off by default: the [web form](web-form.md) stays the way in for strangers. |
| `departmentIds` | The departments whose tickets the portal will show (used from M21-03). |

The help center caches public pages for up to ten minutes. After turning the portal on or off by hand the header links appear or disappear when that cache turns over; the addresses themselves follow the setting at once.

## How signing in works

1. The customer opens `/sign-in` on the brand's help center host (or `/hc/<brandId>/sign-in` while the brand has no domain) and types an address.
2. The page always answers **Check your email**, whether or not the address belongs to a customer. Only a malformed address gets an error. The lookup and the email are queued after the answer is sent, so the response time shows nothing either.
3. If a contact of the brand has that address as an email identity, verified or not, one email is sent. A contact that was merged into another or erased never gets one. With `newCustomers` on, any other address gets one too.
4. The link opens **Continue to your tickets**, which names the brand and the address and has one button. Opening it changes nothing, so a mail scanner or a link preview that follows the link does not use it up.
5. **Continue** spends the link (a `POST`), marks that email identity verified, starts the session and lands on **My tickets**, or on the page the customer was heading for.

A link works once, for 15 minutes, for one brand and one address. Asking again does not cancel an earlier link, so nobody can lock a customer out by requesting links for them. An expired link and a used link each have their own page with a way to ask for a new one; a link for another brand's help center is shown as expired.

### Limits

| Limit | Value |
|---|---|
| Link requests per address | 5 per hour |
| Link requests per IP address | 20 per hour |
| The Continue page and its button, per IP address | 30 per 15 minutes |

Over a limit the form shows the warning, disables its button and sends nothing. When the brand has the built-in check (the proof-of-work CAPTCHA) on for its [web form](web-form.md), the sign-in form asks for the same check above the button. A third-party CAPTCHA provider is not drawn on the sign-in form; the limits above still apply.

### The email

`Email/Portal-SignIn`: the brand's name, one sentence naming the address and the 15 minutes, one button, and one line saying the link works once and what to do if nobody asked for it. It is sent in the language of the page the link was requested from, from the brand's outgoing sender (or the install's), through the outbox, and carries nothing about any ticket.

## Sessions

A session lasts 30 days from its last use. It is bound to the brand and to the help center host it was issued on, so a customer signs in once per brand and per host. The cookie is an opaque 256-bit token; only its SHA-256 is stored.

| | Brand's own host | `/hc/<brandId>` on the install's host |
|---|---|---|
| Cookie name over https | `__Host-hd_cs` | `__Host-hd_cs_<brandId>` |
| Cookie name over plain http | `hd_cs` | `hd_cs_<brandId>` |
| Attributes | `HttpOnly; Secure; SameSite=Lax; Path=/` (no `Secure` over plain http) | the same |

A session also ends when:

- the customer chooses **Sign out** (this browser) or **Sign out everywhere** (every session of the contact), from the menu that replaces **Sign in** in the header on portal pages;
- the email identity it was issued for is removed or is no longer verified;
- the contact is merged into another or erased;
- the brand turns the portal off, which refuses every portal request while it is off.

Every page of the portal is private (`Cache-Control: private, no-store`), is not indexed and never enters the help center's page cache. The "My tickets" and "Sign in" links in the header are the same for every visitor, so public pages stay cacheable; the signed-in menu appears only on portal pages. Every form carries a CSRF token.

Sign-ins, sign-outs and refused links are security events in the application log, without the address. They are not audit-log rows.

## For customers

Your own help center page can say:

> **Signing in to see your tickets.** Open Sign in, type the email address you write to us from, and we send you a link. Press Continue on the page it opens. The link works once and for 15 minutes. You stay signed in on that browser for 30 days after your last visit. Use **Sign out everywhere** if you used a shared computer. If you did not ask for an email, ignore it: nobody is signed in until Continue is pressed.

## Not yet

The ticket list, ticket pages, replying, the company view, the admin screen and the sweep of expired sessions and links (M21-03 to M21-08).
