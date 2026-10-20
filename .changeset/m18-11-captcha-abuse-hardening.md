---
"@helpdock/api": minor
---

**CAPTCHA and abuse hardening (M18-11).**

**Upgrade note for custom widget clients.** If your own app or widget renders Cloudflare Turnstile for `POST /api/widget/:brandId/conversations` (rather than using the bundled widget), it must now render the challenge with `action: 'widget-first-message'` and `cData: '<brandId>'`. The api refuses a Turnstile pass whose action or cData differs or is missing, as it refuses a wrong token, so a conversation can no longer be started with a token solved for the web form or for another brand that shares the site key. The bundled widget and the hosted web form (`action: 'web-form'`) already do this. hCaptcha has neither field and is still bound by hostname only. Refusals are logged at `warn` as `CAPTCHA refused` with the provider's error codes (`action-mismatch`, `cdata-mismatch`, `hostname-mismatch`), never the token.

Also in this release:
- Sign-in link and password reset requests have their own per-IP budget, 30 per 15 minutes (`email-dispatch-ip`), and no longer spend the sign-in budget of the same address.
- The help center's "Was this helpful?" post is limited to 30 per 15 minutes per IP and brand (`hc-feedback-ip`), answered 429.
- The operations guide lists every `rate_limit_refusals_total` bucket, and a test keeps that list complete.
