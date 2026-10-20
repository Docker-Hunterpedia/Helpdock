---
"@helpdock/api": minor
---

**CAPTCHA and abuse hardening (M18-11).** A Turnstile token now carries the surface it was solved for: the widget renders it with the action `widget-first-message` and the web form with `web-form`, and the api refuses a pass for the other surface (`action-mismatch`), on top of the 1.0.1 hostname check. Sign-in link and password reset requests have their own per-IP budget, 30 per 15 minutes (`email-dispatch-ip`), and no longer spend the sign-in budget of the same address. The help center's "Was this helpful?" post is limited to 30 per 15 minutes per IP and brand (`hc-feedback-ip`), answered 429. The operations guide lists every `rate_limit_refusals_total` bucket.
