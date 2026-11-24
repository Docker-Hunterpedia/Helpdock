# Email: receiving mail

How a brand receives customer email (M2-02, M2-03, M2-04, M2-07, M2-08). Sending replies and auto-replies is the other half of M2: see [Outbound email](outbound-email.md).

Everything here is on **Settings › Channels › Email**, which only an Admin of the brand can open (`brand:manage`).

## Mailboxes

A mailbox is an address customers write to and the department its new tickets are filed in. Replies to an existing ticket stay in that ticket's department. An address can belong to one mailbox in the whole install.

Each mailbox collects its mail one of two ways.

### IMAP polling

Helpdock signs in to the mailbox and fetches new mail every 30 s, 60 s, 2 min or 5 min.

| Field | Notes |
|---|---|
| IMAP host, port | `993` with **TLS**, or `143` with **STARTTLS**. STARTTLS refuses to continue if the server does not offer the upgrade. |
| Username, password | Many providers (Fastmail, Gmail, iCloud) need an *app password*. The password is encrypted with `APP_MASTER_KEY` and never shown again; **Replace** sets a new one. |
| Folder | Usually `INBOX`. |

**Test IMAP** signs in with the values on the screen, saved or not, and reports the folder's message count or the server's exact refusal. Nothing is imported. On a saved mailbox it uses the stored password unless you typed a new one, and only while the host, port, security mode and username are the saved ones: change any of them and the password must be typed again, on the same screen (400 `password-required`, field `body.imap.password`, or `body.password` for the test). Saving a mailbox follows the same rule, so a changed host cannot be made to receive the stored password.

The first poll imports the folder's *unseen* messages, not its history. Every message taken is flagged `\Seen` on the server. A host that resolves to a private or internal address is refused (DOMAIN-RULES §13); allow it with `OUTBOUND_ALLOW_CIDRS` if your mail server is inside your network.

### Inbound parse webhooks

Your mail provider posts each message to Helpdock. The recipient address picks the mailbox.

Use `https://<API_HOST>` as the base URL for the endpoints below. Both bundled
Caddy configurations also accept these webhooks on `ADMIN_HOST`, which serves
the REST API too. With the bundled Caddy, brand help-center domains block all
`/internal/*` paths; the API and admin hosts block every internal path except
`/internal/inbound-parse/*`.

For host-proxy and platform installs, see [External proxy](deploy.md#external-proxy):
nginx and Traefik need the opt-in inbound-parse exception shown there; the
platform templates ship no path-deny rules.

| Provider | Endpoint | Configure |
|---|---|---|
| Postmark | `/internal/inbound-parse/postmark` | Inbound webhook URL. Turn on "Include raw email content" for the most faithful parse. |
| SendGrid | `/internal/inbound-parse/sendgrid` | Inbound Parse with **Send raw** on. |
| Mailgun | `/internal/inbound-parse/mailgun` | A route forwarding to the URL; a URL ending in `mime` style (`body-mime`) is preferred. |
| Resend | `/internal/inbound-parse/resend` | Only payloads that include `html` or `text`. Resend's default `email.received` webhook carries no body and is answered `422`. |
| Anything else | `/internal/inbound-parse/generic` | `POST` JSON: `{ "raw": "<RFC 5322 message>" }`, or `{ from, to, cc?, subject, text?, html?, messageId?, inReplyTo?, references?, headers?, attachments? }`. |

Every request must carry the brand's **shared secret**, either as the `X-Helpdock-Inbound-Secret` header or as the password of HTTP Basic auth in the URL (`https://inbound:SECRET@api.example.com/internal/inbound-parse/postmark`). **Replace** on the Inbound parse card makes a new secret and shows it once; providers still using the old one are refused from that moment. A request with a wrong secret and one for an address that is no mailbox get the same `401`.

For an existing 1.0.x install, apply the Caddy routing fix described in
[Upgrading](operations.md#upgrading) before configuring a parse provider.

Answers: `200 {"outcome":"accepted"}` for a new message, `duplicate` for one already received (same `Message-ID`), `ignored` for automated or blocked senders. Providers should not retry any `200`.

## What happens to a message

1. **Duplicates** of live email are recognised by `Message-ID` and dropped. Imported historical IDs do not suppress new live deliveries.
2. **Automated mail** — `Auto-Submitted`, `Precedence: bulk/list/junk`, mailing-list headers, out-of-office markers, `noreply@`-style senders — never opens a ticket unless its address is in the mailbox's **Automated senders that may open tickets** list. It is logged.
3. **Blocked senders** (Inbox › Spam) are dropped and counted.
4. **Threading** (DOMAIN-RULES §4.3). A message joins an existing ticket only when it references it — by `In-Reply-To`/`References` naming a message Helpdock received or sent on the ticket (an agent's emailed reply or an auto-reply counts), or the brand's `[HD-1042]` token in the subject — **and** the sender is a participant: the ticket's contact, a CC, or staff on the ticket. Anyone else gets a new ticket in the same department with the note "Referenced HD-1042 but sender is not a participant", from which an agent can open or merge.
   Migration support is in development. If an imported Message-ID names multiple
   tickets, Helpdock starts a new ticket rather than guessing; a subject token does
   not override that ambiguity. Verified Helpdock delivery IDs and live received
   email take precedence over imported history.
5. **The body** is sanitised (no scripts, forms or styles), the quoted history is folded behind "Show quoted text", inline images become the message's attachments, and other attachments go through the media pipeline like any upload.
6. **Remote images** are never in the stored body. With **Block until an agent loads them** the email card shows how many and from where; **Load images** fetches them through Helpdock's proxy. With **Load through the Helpdock image proxy** they load at once. Either way the server fetches them, re-encodes them, and the sender never sees an agent's address or browser.
7. **SPF or DKIM failures** reported by your receiving server open the ticket in Spam when the mailbox's switch is on. See Sender checks below.
8. **Auto-replies.** A message that opened a ticket may get the brand's acknowledgment or out-of-hours reply ([Outbound email](outbound-email.md#auto-replies-m2-06)). Mail from a machine (even an allow-listed one) and mail filed as spam never does.

Everyone on the `To` and `Cc` lines, except the brand's own mailboxes and the sender, becomes a CC participant of the ticket, unless the message is reported as not matching its From address (see below).

### Sender checks

Helpdock acts on what the receiving mail server reported. Mail reported as failing SPF or DKIM, as failing DMARC, or as passing only for some other domain than its From address adds no `To` or `Cc` participants and does not verify its sender's address. It still joins the ticket it replies to, with the "authentication failed" warning when SPF or DKIM failed, so forwarded mail is not lost, and its sender is found by address: an existing contact keeps their ticket, and a new address gets one unverified contact that the first sound message verifies.

Mail with no report is treated as before. The report is the `Authentication-Results` header (a DKIM or SPF pass counts only for the From domain or a subdomain or parent of it). Which inbound methods carry it:

| Method | Carries it |
|---|---|
| IMAP | Only if your mail server adds one. Gmail, Microsoft 365 and most hosted mailboxes do; a self-hosted server without an SPF/DKIM/DMARC filter does not. |
| Raw MIME from a provider (Postmark raw, SendGrid raw, Mailgun `body-mime`, generic `{ "raw": ... }`) | The headers of the message as your server received it, so the same as IMAP. |
| Provider webhooks without the raw message | Only the headers the provider copies in. Helpdock does not read the providers' own result fields. |
| Generic JSON with `headers` | Whatever the caller sends. |

Where there is no report, this change gives no protection. A relay you do not control can also write its own `Authentication-Results`, so treat the check as best effort.

## A reply aimed at one email

An agent can answer one particular email of a ticket instead of the latest
(Reply on that email in the thread, [Tickets](tickets.md#replying-to-one-email)).
The outgoing mail then:

- sets `In-Reply-To` to that email's `Message-ID` and `References` to the chain
  that arrived with it plus that id, so the customer's mail client files the
  reply under the email it answers;
- carries, under the reply and above its signature, "On Tue, 10 Nov 2026 at 12:05
  UTC, Mona Khalil wrote:" in the customer's language and that email's text: a
  blockquote in the HTML part and `> ` lines in the text part, cut at 2,000
  characters and escaped. The quote sits above the `-- ` line because a text
  client reads everything after it as the signature. Its attachments are not
  sent again.

The quote is added when the mail is sent; the reply stored on the ticket is only
what the agent wrote. A `Message-ID` or `References` entry that is not a single
well-formed id is left out of the headers rather than copied, and an email with
no usable `Message-ID` is answered as an ordinary reply. To, Cc and From are the
ticket's, as for any reply. An email whose sender was erased is neither quoted
nor threaded to, and cannot be chosen.

## Health

| State | Meaning |
|---|---|
| Healthy | The last poll or delivery worked. |
| Behind | No successful poll for three intervals. |
| Failing | The server refused sign-in, could not be reached, or the folder is missing. The list says which, and when. |
| Waiting | An inbound-parse mailbox that has not received mail yet. |
