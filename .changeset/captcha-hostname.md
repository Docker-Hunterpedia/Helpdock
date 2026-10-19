---
"@helpdock/api": patch
---

CAPTCHA: the widget and the hosted web form now check the hostname Turnstile or hCaptcha reports for a solved challenge. A token solved on a site that is not one of the brand's allowed widget origins (widget), or not `APP_URL` or a verified help center domain (web form), is refused even when the provider accepted it. Cloudflare's dummy test keys report `example.com` and so no longer pass.
