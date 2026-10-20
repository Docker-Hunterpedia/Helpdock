# Web form

A page where customers write to a brand without chat: every submission opens a ticket (M4-09, [REQUIREMENTS §4.4](../planning/REQUIREMENTS.md#44-channels), [ADR 0013](../decisions/0013-web-form-page-rendered-by-the-api.md)).

## Where it is served

| Address | When |
|---|---|
| `https://<help center host>/contact` | The brand has a verified help center domain (Brand › Domains). |
| `<APP_URL>/contact/<brandId>` | Always, including before the brand has a domain. |

**Channels › Web form** shows the address to copy or open. On a help center host, `/contact` is that brand's form and `/contact/<another brand>` is a 404: one brand's domain never serves another's form. `?lang=en` or `?lang=ar` picks the page's language; otherwise it is the brand's default. The page links to the other language.

`?article=<article id>` is "Still need help?" from a help center article (M5-08): the form carries the id in a hidden field, and the ticket's thread tells the agents which article the customer came from. It is recorded only for a published, public article of the brand; any other value is dropped, never refused.

The page is plain HTML with no script of its own, so it works with JavaScript off. Its CSP allows nothing but its own style, the self-hosted fonts at `/_hd/fonts/`, and — only while CAPTCHA is on — the provider's script and frame, or, for the built-in check, its own inline script under the page's nonce and `connect-src 'self'`.

## Channels › Web form

**Admin → Channels → Web form** (Admin only, `brand:manage`). Two cards, each with its own Save.

| Setting | What it does |
|---|---|
| The form is on | Off by default. Off, the address answers 404 "This form is closed". |
| Fields | The four built-in fields and every ticket custom field, in the order the form draws them. The grip on each row moves it with the up and down arrow keys. **Shown** and **Required** per field; a hidden field is never required. Email and Message are always shown and required. |
| Opens tickets in | The department new tickets are filed in: its agents, rules and SLA policy apply. By default, the brand's first department. |
| Check for bots before sending | The check chosen on the **Widget** tab: the built-in check (no keys, nothing sent to a third party), Turnstile or hCaptcha. Turnstile or hCaptcha on without their keys means the form takes nothing and the page says it is not available; the tab warns about it. |
| Thank-you message | One per language, shown on the page after a successful send. `{{ticket.number}}` becomes the reference, like `HD-1043`. Left as it ships, it follows the catalog's wording as that improves. |

Showing a custom field sets its **Show on web form** flag (`custom_field_defs.web_form`). The answers are validated against the field's type and stored on the ticket's custom fields like any other. Every save writes an audit row, `web_form.updated`, naming what changed.

Attachments follow the brand's [content policy](attachments.md#the-content-policy): the image and file kinds only (voice and video belong to the chat widget), at most five files and at most the policy's per-message count, each within its kind's size cap. The page lists the types and sizes it takes. The whole request is capped at 30 MB.

## What a submission does

In order, before anything is written:

1. A filled honeypot field is refused (400).
2. The fields are checked. Anything missing, malformed or too long comes back as the form with what was typed, an error summary that takes focus and links to each field, and a message under each (422).
3. **Per IP**: 10 submissions that pass the field check, per brand per 15 minutes (429).
4. **CAPTCHA**, when on, verified server-side through the SSRF-safe client (422 on failure). It runs after the field check so a customer fixing a typo does not solve a second challenge. A site key is public and works on any site, so from 1.0.1 a pass also has to report one of the form's own hosts: `APP_URL`'s host or one of the brand's verified help center domains. A token solved anywhere else fails like a wrong one, and the api logs `web form CAPTCHA refused` with `hostname-mismatch`. From 1.1 the page also renders Turnstile with the action `web-form` and the brand's id as `cData`, and a Turnstile pass for another action (the widget's `widget-first-message`) or another brand sharing the site key fails the same way, with `action-mismatch` or `cdata-mismatch`. hCaptcha has neither field, so its tokens are bound by host only.
   With the built-in check (ADR 0052) the page draws a strip instead of a provider box: its inline script solves the challenge the page carries while the customer types, says "Checking your connection…" then "Verified", and only then enables **Send message**. If the check fails it says "We couldn't check your connection." and offers **Try again**, which fetches a new challenge from `/contact/challenge` (or `/contact/<brandId>/challenge`; 404 when the form asks for no built-in check). Without JavaScript the strip says the form needs JavaScript to send. The solution is posted in `hd_pow`; a solution is good once, for this brand and this form, for 15 minutes, and a second post of it fails like a wrong one.
5. **Per address**: 5 submissions per brand per typed email per hour (429).
6. A sender on the brand's block list is refused (400).

Then one transaction files a `form`-channel ticket exactly as an inbound email files one: the contact, the first message (the text escaped into paragraphs), the attachments into the media pipeline, `ticket.created` activity, the SLA clocks, the `ticket.created` event (rules, notifications, the live list) and auto-assignment. It also writes `email.received`, so the brand's acknowledgment auto-reply goes out by email when the brand has a sender and has it on (see [Outbound email](outbound-email.md)); replies to the ticket are emailed like replies to an email ticket.

The page then shows the reference and the brand's thank-you message. A second post of the same form — a double click, a refresh of the thank-you page — carries the same hidden submission id and answers the ticket the first one filed.

## The typed address is a claim

An email typed into the form is never verified ([DOMAIN-RULES §4.4](../planning/DOMAIN-RULES.md#44-contact-merge)): it goes through the identity seam as `web.form`. When nobody holds the address, the new contact holds it, unverified. When another contact already holds it, the submission gets a new contact and a "possible duplicate" suggestion on the contact page, never the other contact's history; until an agent merges the two, the new contact has no address of its own, so the acknowledgment reaches the typed address but agent replies are not emailed.
