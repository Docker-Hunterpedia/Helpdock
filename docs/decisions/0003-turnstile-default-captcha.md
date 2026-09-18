# 0003 Use Cloudflare Turnstile as the default CAPTCHA, hCaptcha as the alternative

Status: accepted
Date: 2026-09-18

## Context

Two visitor-facing surfaces can be flooded by bots: the hosted web form per brand, which specifies a CAPTCHA toggle ([REQUIREMENTS §4.4](../planning/REQUIREMENTS.md#44-channels)), and the chat widget, whose security requirements list an allowed-origin check, signed visitor identity, per-visitor and per-IP rate limits, a CAPTCHA option, no inline scripts and a strict CSP ([REQUIREMENTS §5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable)). The widget must stay under 40 KB gzipped and carry no framework.

A CAPTCHA is by nature a third-party script: the point is that the challenge is issued and judged by someone who sees traffic we do not. That collides with two other properties we want. The widget's default content security policy should name no third-party host, and self-hosters differ in what they are allowed to send abroad — some operators cannot route visitor data to a US provider at all, and the product must remain fully usable for them.

So the decision is not only which provider, but how little of the product depends on there being one.

## Decision

Define one `CaptchaProvider` interface in `packages/channels` with two operations: `renderConfig(brand)`, which returns what the client needs to render a challenge, and `verify(token, remoteIp, idempotencyKey)`, which returns success or a list of error codes.

Two implementations ship in v1:

- **Cloudflare Turnstile** — the default when an admin enables CAPTCHA. Server-side validation is a POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret` and `response`, optionally `remoteip` and `idempotency_key`; the response carries `success`, `challenge_ts`, `hostname` and `error-codes`.
- **hCaptcha** — selectable per brand in admin. Server-side validation is a form-encoded POST to `https://api.hcaptcha.com/siteverify` with `secret` and `response`, optionally `remoteip`, returning the same shape.

The two APIs are close enough that one interface is a genuine abstraction rather than a lowest common denominator. Per-brand sitekey and secret live in the `settings` table; the secret is encrypted with AES-256-GCM under `APP_MASTER_KEY` and is never returned to the client after save. Both verification calls go through the SSRF-safe outbound client ([DOMAIN-RULES §13](../planning/DOMAIN-RULES.md#13-outbound-network-safety)) even though the hosts are ours to choose, so that there is exactly one audited path out of the process.

CAPTCHA is off by default. When it is on, a missing or failing token is rejected with a 4xx before any ticket, contact or conversation row is created.

## Consequences

- Turnstile needs `script-src https://challenges.cloudflare.com` and `frame-src https://challenges.cloudflare.com` in the CSP of any page that renders it, and the script is fetched from Cloudflare in the visitor's browser. Those directives are therefore added to a brand's CSP only when that brand has CAPTCHA enabled. The widget's default CSP keeps no third-party host, which is what most installs will ship.
- The provider script is loaded at runtime and is not bundled, so the 40 KB widget budget is unaffected. What the widget does gain is a network-dependent step before the first message on brands that enable it. It has to fail visibly — an error the visitor can act on — rather than hang on a blocked or slow script.
- Two providers means two config paths, two sets of documentation and two integration tests. Because the verify contract is nearly identical, each adapter is thin and the second one is close to free. It also proves the interface is real, which is the point: a third provider later is an adapter, not a refactor.
- Neither provider is self-hostable. An install that cannot or will not talk to Cloudflare or to hCaptcha leaves CAPTCHA off and relies on the allowed-origin check, signed visitor identity and rate limits. That is the default configuration anyway, so it is a supported state, not a degraded one.
- Making Turnstile the default is a recommendation, not a lock-in. It is free at the volumes a support widget sees and usually resolves without showing a puzzle, which matters on a support form where the visitor is already frustrated enough to be asking for help.

## Alternatives considered

- **Google reCAPTCHA.** Rejected for the same reason as Firebase in [ADR 0002](0002-web-push-via-vapid.md): it places Google in the path of every visitor who opens a support form, and it hands each self-hoster a data-protection question they then have to answer in their own privacy policy and, in the EU, defend. The default choice of an AGPL support tool should not create that obligation for its operators. It is not excluded forever — the `CaptchaProvider` interface would take a third adapter — but it will not be what we ship or recommend.
- **A self-hosted proof-of-work challenge.** Genuinely attractive for this product: no third party, no visitor data leaving the install, and a perfect fit for the self-hosted story. Rejected for v1 on honest grounds. Proof-of-work stops naive scripted floods but not a determined or a paid attacker, it taxes exactly the low-powered phones many of our visitors use, and it would make anti-abuse our problem to own and tune. It is a good candidate for a third provider behind the same interface once that interface has proven itself in production; it is not v1 scope.
