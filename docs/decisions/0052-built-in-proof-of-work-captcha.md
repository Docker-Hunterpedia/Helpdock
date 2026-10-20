# 0052 A built-in proof-of-work CAPTCHA provider

Status: accepted (owner decision D-51, 2026-10-20)
Date: 2026-10-20

Amends [0003](0003-turnstile-default-captcha.md).

## Context

ADR 0003 made Cloudflare Turnstile the default CAPTCHA and hCaptcha the
alternative, behind one `CaptchaProvider` interface
(`packages/channels/src/captcha.ts`), and named proof-of-work "a good candidate
for a third provider behind the same interface once that interface has proven
itself". It has, across M4 and M9. Both existing providers send visitor signals
to a third-party processor and can challenge visitors on VPNs and some regional
networks harder. Some operators cannot send visitor data to a CAPTCHA vendor,
and air-gapped installs cannot reach one. Separately, the widget and web form
ignore the `hostname` in a provider's verdict today.

Planned in [M18 Sign-in options](../in-development/M18-sign-in-options.md)
(M18-10, M18-11).

## Decision

1. Add a third provider, **`pow`**, to `CAPTCHA_PROVIDERS`. The server signs
   `{ algorithm: 'SHA-256', challenge, salt, maxnumber, expires }` with
   HMAC-SHA256 under a key derived from `APP_MASTER_KEY` with HKDF. The client
   finds `n` such that `SHA-256(salt + n) === challenge` with WebCrypto, in a
   lazy widget chunk and inline in the server-rendered web form page. Verify
   recomputes, checks the HMAC and `expires`, and spends the challenge once
   through a Redis `SET NX` keyed by its hash.
2. **No new dependency**: about 80 lines of `node:crypto`. The payload is
   ALTCHA-protocol-compatible, so an operator could swap in the ALTCHA widget
   later.
3. **Difficulty** is a setting, `captcha.difficulty`: `low` (default,
   `maxnumber` 50,000, about 0.5–1 s on a 2020 mid-range Android) or `medium`
   (200,000).
4. **Hostname check** for Turnstile and hCaptcha: the verdict's `hostname` must
   be one of the brand's widget origins or the web form host; Turnstile tokens
   carry an `action` per surface.
5. **Default provider:** `pow` when an admin turns CAPTCHA on for a brand that
   never chose a provider, with Turnstile as the "stronger bot detection"
   choice; a brand that saved its access card before keeps its provider. This
   changes ADR 0003's default (owner decision D-51, 2026-10-20).
6. **Binding.** Each brand signs under its own key (HKDF info
   `helpdock:captcha:pow:<brandId>`), and the salt carries the surface
   (`widget-first-message` or `web-form`) next to `expires`, so a solution is
   good for one brand, one surface and fifteen minutes. The widget fetches
   challenges from `GET /api/widget/:brandId/captcha/challenge`; the web form
   carries one in the page and fetches another from `…/challenge` for "Try
   again".

## Consequences

- No visitor data leaves the install and no CSP host is added; nothing to solve
  or see, which is the most accessible of the three.
- Proof-of-work raises the cost of naive floods, not of a determined attacker.
  It stays defence in depth on top of the origin check, signed identity and
  rate limits, and the tests assert that it never replaces them.
- Low-end phones pay the work; the default difficulty is low and the failure
  state offers a retry.

## Alternatives considered

- **`altcha-lib`** (MIT, zero dependencies): 2.6.0 was too new to pin on
  2026-10-20; the in-house code is small, as with the breached-password list
  ([ADR 0021](0021-bundled-breached-password-list.md)).
- **The `altcha` web component:** its unpacked size needs measuring against the
  40 KB widget budget.
- **reCAPTCHA:** stays rejected (ADR 0003).
- **CAPTCHA on staff sign-in:** rejected; it would put a third-party script on
  the most sensitive page, and the existing limits meet ASVS L2.
