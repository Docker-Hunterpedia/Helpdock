---
'@helpdock/api': minor
---

Hosted web form per brand (M4-09). Each brand gets a contact page at `/contact` on its help center domain (and at `/contact/<brandId>` on the install's own address until it has one), rendered by the api as plain HTML in English and Arabic, with the built-in fields, the ticket custom fields marked "Show on web form", attachments within the brand's content policy, and an optional Turnstile or hCaptcha check verified server-side. A submission opens a `form`-channel ticket through the same pipeline as inbound email, so contacts, rules, SLAs, notifications and the acknowledgment auto-reply all apply; per-IP and per-address rate limits and a honeypot keep floods out. New: **Channels › Web form** to turn the form on, arrange its fields, route it to a department, toggle CAPTCHA and write the English and Arabic thank-you messages.
