# Email: receiving mail

How a brand receives customer email (M2-02, M2-03, M2-04, M2-07, M2-08). Sending replies and auto-replies is the other half of M2: see [Outbound email](outbound-email.md).

Everything here is on **Admin › Channels › Mailboxes**, which only an Admin of the brand can open (`brand:manage`).

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

**Test IMAP** signs in with the values on the screen, saved or not, and reports the folder's message count or the server's exact refusal. Nothing is imported. On a saved mailbox it uses the stored password unless you typed a new one.

The first poll imports the folder's *unseen* messages, not its history. Every message taken is flagged `\Seen` on the server. A host that resolves to a private or internal address is refused (DOMAIN-RULES §13); allow it with `OUTBOUND_ALLOW_CIDRS` if your mail server is inside your network.

### Inbound parse webhooks

Your mail provider posts each message to Helpdock. The recipient address picks the mailbox.

| Provider | Endpoint | Configure |
|---|---|---|
| Postmark | `/internal/inbound-parse/postmark` | Inbound webhook URL. Turn on "Include raw email content" for the most faithful parse. |
| SendGrid | `/internal/inbound-parse/sendgrid` | Inbound Parse with **Send raw** on. |
| Mailgun | `/internal/inbound-parse/mailgun` | A route forwarding to the URL; a URL ending in `mime` style (`body-mime`) is preferred. |
| Resend | `/internal/inbound-parse/resend` | Only payloads that include `html` or `text`. Resend's default `email.received` webhook carries no body and is answered `422`. |
| Anything else | `/internal/inbound-parse/generic` | `POST` JSON: `{ "raw": "<RFC 5322 message>" }`, or `{ from, to, cc?, subject, text?, html?, messageId?, inReplyTo?, references?, headers?, attachments? }`. |

Every request must carry the brand's **shared secret**, either as the `X-Helpdock-Inbound-Secret` header or as the password of HTTP Basic auth in the URL (`https://inbound:SECRET@support.example.com/internal/inbound-parse/postmark`). **Replace** on the Inbound parse card makes a new secret and shows it once; providers still using the old one are refused from that moment. A request with a wrong secret and one for an address that is no mailbox get the same `401`.

Answers: `200 {"outcome":"accepted"}` for a new message, `duplicate` for one already received (same `Message-ID`), `ignored` for automated or blocked senders. Providers should not retry any `200`.

## What happens to a message

1. **Duplicates** are recognised by `Message-ID` and dropped.
2. **Automated mail** — `Auto-Submitted`, `Precedence: bulk/list/junk`, mailing-list headers, out-of-office markers, `noreply@`-style senders — never opens a ticket unless its address is in the mailbox's **Automated senders that may open tickets** list. It is logged.
3. **Blocked senders** (Ticketing › Spam) are dropped and counted.
4. **Threading** (DOMAIN-RULES §4.3). A message joins an existing ticket only when it references it — by `In-Reply-To`/`References` naming a message Helpdock received or sent on the ticket (an agent's emailed reply or an auto-reply counts), or the brand's `[HD-1042]` token in the subject — **and** the sender is a participant: the ticket's contact, a CC, or staff on the ticket. Anyone else gets a new ticket in the same department with the note "Referenced HD-1042 but sender is not a participant", from which an agent can open or merge.
5. **The body** is sanitised (no scripts, forms or styles), the quoted history is folded behind "Show quoted text", inline images become the message's attachments, and other attachments go through the media pipeline like any upload.
6. **Remote images** are never in the stored body. With **Block until an agent loads them** the email card shows how many and from where; **Load images** fetches them through Helpdock's proxy. With **Load through the Helpdock image proxy** they load at once. Either way the server fetches them, re-encodes them, and the sender never sees an agent's address or browser.
7. **SPF or DKIM failures** reported by your receiving server open the ticket in Spam when the mailbox's switch is on.
8. **Auto-replies.** A message that opened a ticket may get the brand's acknowledgment or out-of-hours reply ([Outbound email](outbound-email.md#auto-replies-m2-06)). Mail from a machine (even an allow-listed one) and mail filed as spam never does.

Everyone on the `To` and `Cc` lines, except the brand's own mailboxes, becomes a CC participant of the ticket.

## Health

| State | Meaning |
|---|---|
| Healthy | The last poll or delivery worked. |
| Behind | No successful poll for three intervals. |
| Failing | The server refused sign-in, could not be reached, or the folder is missing. The list says which, and when. |
| Waiting | An inbound-parse mailbox that has not received mail yet. |
