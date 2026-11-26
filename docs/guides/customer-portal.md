# Customer portal

The customer portal lets a customer sign in to a brand's help center and read their tickets there; answering them and opening new ones follow in later releases. This guide covers what exists after **M21-03**: signing in and out, the ticket list and the ticket page (read only). Replying and new tickets arrive with M21-04, and the admin screens with M21-06. The plan is [M21 Customer portal](../in-development/M21-customer-portal.md); the decision is [ADR 0059](../decisions/0059-customer-sessions-by-emailed-link.md).

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
| `departmentIds` | The departments whose tickets the portal shows: `"all"` or a list of department ids. A ticket in any other department is not listed and its address answers 404. |

The help center caches public pages for up to ten minutes. After turning the portal on or off by hand the header links appear or disappear when that cache turns over; the addresses themselves follow the setting at once.

## How signing in works

1. The customer opens `/sign-in` on the brand's help center host (or `/hc/<brandId>/sign-in` while the brand has no domain) and types an address.
2. The page always answers **Check your email**, whether or not the address belongs to a customer. Only a malformed address gets an error. The lookup and the email are queued after the answer is sent, so the response time shows nothing either.
3. If a contact of the brand has that address as an email identity, verified or not, one email is sent. A contact that was merged into another or erased never gets one. With `newCustomers` on, any other address gets one too.
4. The link opens **Continue to your tickets**, which names the brand and the address and has one button. Opening it changes nothing, so a mail scanner or a link preview that follows the link does not use it up.
5. **Continue** spends the link (a `POST`), marks that email identity verified (source `portal.sign_in`; a new customer's contact is created through the same code the web form uses), starts the session and lands on **My tickets**, or on the page the customer was heading for.

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

## What to know before turning it on

These behaviours are accepted, by design:

- **Whoever presses Continue is signed in as the address the page names.** A link is a bearer credential for 15 minutes. If someone opens a link another person requested, and presses Continue, they are signed in as that address. The page names the address and says what to do if nobody asked, and a mail scanner that only opens the link signs nobody in.
- **Any email identity of a contact lets the owner of that mailbox sign in as that contact, verified or not.** A ticket someone opened by typing another person's address on the web form or the widget is therefore readable by the owner of that mailbox, as is every other ticket of that contact. The link itself goes only to the mailbox.
- **Do not use the portal over plain http.** On an install whose `APP_URL` is `http://`, the cookies lose `Secure` and the `__Host-` prefix (a prefixed cookie would be dropped), so they can be read or planted on the network. Use https; plain http is for local development only.
- **Anyone can use up an address's 5 requests an hour.** Earlier links stay valid for their 15 minutes, so the owner is not locked out of a link they already have, but cannot ask for a new one until the hour passes.

### Reverse proxy and access logs

The link carries the token in the query string of `/sign-in/confirm?token=…`. Helpdock does not log it, but a reverse proxy in front of it (Caddy, nginx, a load balancer, a CDN) usually logs the full request line. For a link not yet spent, that log holds a working credential for up to 15 minutes (it works once, and only until Continue is pressed). Exclude the query for that path, or keep those logs as protected as the mailbox. In Caddy:

```caddyfile
log {
  format filter {
    request>uri query {
      delete token
    }
  }
}
```

and in nginx, log `$uri` rather than `$request_uri` for the site that serves the help center.

## Sessions

A session lasts 30 days from its last use: the server moves the expiry forward at most every 15 minutes and sends the cookie again with a fresh 30-day lifetime when it does, so a customer who visits at least once a month stays signed in. It is bound to the brand and to the help center host it was issued on, so a customer signs in once per brand and per host. The cookie is an opaque 256-bit token; only its SHA-256 is stored.

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

## My tickets

After signing in, **My tickets** (`/tickets`, below `/hc/<brandId>` while the brand has no domain) lists the customer's tickets. It is made for the board `HelpCenter/Portal-Tickets`.

### What a customer sees in the list

- **Mine:** tickets the customer opened, on every channel (email, web form, widget, Telegram, WhatsApp, Messenger, Instagram), and tickets a **staff member added them to as a CC** while the address is a verified identity of theirs. A person who was copied only on an inbound email does not get the ticket in their portal.
- **Open and Solved.** Open is the default. A ticket is Solved once its status is closed.
- **One of four words**, whatever the brand called its statuses: **Open**; **Waiting for you** (the status is one where the ball is with the customer); **Waiting for us** (on hold, escalated, or snoozed); **Solved**.
- Each row: the subject, the reference (`HD-1042`), when it last changed ("2 hours ago", "yesterday", a date once it is a month old), and **Only you** on the customer's own ticket that is private. Newest change first, 20 to a page; **Show more** is a plain link, so the page works without JavaScript.
- **Search** matches the subject (anywhere in it) and the reference or its number (`HD-1042`, `hd-1042`, `1042`), only among the tickets the customer may see. It is a case-insensitive "contains" on the subject, so on a very large company it reads the company's tickets rather than an index of words.
- **Empty states** say where tickets come from. There is no "New ticket" button yet (M21-04).

### The company view

Only when the customer's company is set (by staff, for now in the database; the admin screen is M21-06) to show **All members**, or **Managers** and the customer is a manager, the list has a **Mine / *Company name*** switch with counts. **Company** lists every ticket of the company that is not private, each row saying who opened it ("Opened by you", "Opened by Omar Saleh"). A person's name is shown, never an address. Two notices, which cannot be dismissed, say what the company can see:

- a member of an **All members** company is told, on Mine, that the people at the company can see the tickets they open;
- a manager is told, on Company, that they see every ticket because they are a company manager.

A ticket staff marked **private** shows only to its requester and to staff-added CCs, whatever the setting. A customer whose company shows only their own tickets has no switch, and `?scope=company` is ignored.

### The ticket page

`/tickets/HD-1042`: the subject, the reference, the status, who opened it ("Opened by you · 10 Nov 2026 · by email"), then **every public message** and every assistant message, oldest first, each in an article named by its sender and time. Times are in the brand's time zone, never the viewer's. A message shows who wrote it: **You**; a coworker by name with a **Coworker** tag; staff by their public name ("Lina from *Brand*", DOMAIN-RULES §2.10, with a **Support** tag), never their full name, address or job title; the assistant and automatic messages as the brand's name. Message text is shown as plain text in paragraphs; formatting an agent used is not drawn. Attachments are links to `/tickets/HD-1042/attachments/<id>`, which check the ticket, then redirect to a short-lived download address (five minutes). A copied link stops working.

If tickets were merged into this one, their public messages appear in the thread in time order, **but a merge does not undo what hid a ticket**: a merged ticket that is private is shown only to its own requester (unless this ticket is private too, when it has this ticket's audience), one that was in a department the portal does not show before the merge is never shown, and neither is a spam or deleted one. Nothing marks the place of a withheld message, and its files answer 404. The merged ticket's own reference sends the customer to this one, but only if they can see it.

A solved or closed ticket shows its status and nothing more here yet: replying, reopening and the rating are M21-04.

### What is never shown

Internal notes, system lines, activity, tags, priority, SLA, who the ticket is assigned to, custom fields, the assistant's sources and costs, email headers, other people's addresses, and tickets that are deleted, spam, merged away, in a department the portal does not show, or another company's. A ticket the customer may not see, one that does not exist, and a malformed reference all answer the **same** page: the help center's "We can't find that page", with status 404, never "forbidden". A file of a note, a file still uploading, and another customer's file answer 404 the same way.

### Limits to know

- A thread shows its first 500 messages. A message longer than 200,000 characters is cut with an ellipsis and says it is shown in part; a message shows its first 50 files and "and N more files"; a subject is cut at 1,000 characters and a file name at 255.
- **Limits per signed-in session**: 120 page views (the list and the ticket pages together) and 60 file fetches in five minutes. Over a limit the page is a plain 429 with `Retry-After`. A person reading tickets stays well under; a script walking references does not.
- A person's name is shown to coworkers only when it is a name: a WhatsApp number, a Messenger, Instagram or Telegram id, an Instagram handle or the widget's `Visitor xxxxxx` is never shown, and the page says "a coworker" or "another participant".
- A help center served on a brand's own domain over plain http on a non-standard port (local development) gets absolute links, such as the one in the sign-in email, without the port, because the portal builds them from the verified domain and never from the `Host` header as sent. The pages themselves, and the install's `/hc/<brandId>` path, are fine. Use https, or the `/hc/<brandId>` path, when developing.

## For customers

Your own help center page can say:

> **Signing in to see your tickets.** Open Sign in, type the email address you write to us from, and we send you a link. Press Continue on the page it opens. The link works once and for 15 minutes. You stay signed in on that browser for 30 days after your last visit. Use **Sign out everywhere** if you used a shared computer. If you did not ask for an email, ignore it: nobody is signed in until Continue is pressed.

## Not yet

Replying, attachments from the customer, new tickets, marking solved and the rating (M21-04), the company view's reply on a coworker's ticket (M21-05), the admin screen (M21-06), "View this ticket" in emails (M21-07) and the sweep of expired sessions and links (M21-08).
