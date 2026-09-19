# 7. sanitize-html for message bodies

Date: 2026-09-19 · Status: accepted · Deliverable: M1-03

## Context

[REQUIREMENTS §5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable)
makes it non-negotiable: "Email: no HTML JS/forms rendered; sanitized HTML
(allowlist), remote images proxied/blocked (toggle)."

Every `ticket_messages.body_html` is rendered in the admin, and from M2 the same
bodies arrive from strangers by email. A body is sanitised **on the way in** and
stored sanitised, because a body stored raw is a body that will eventually be
rendered by something that forgot.

The stack table in [ARCHITECTURE §1](../planning/ARCHITECTURE.md#1-stack-at-a-glance)
names no sanitiser, so this needs a decision.

## Options

**Write one.** An HTML sanitiser is a parser plus an allowlist, and the parser is
the hard half: the attacks are mutation XSS, `<svg>` and `<math>` foreign
content switching parsing modes, `noscript` behaving differently with scripting
on and off, and namespace confusion. A hand-written sanitiser is a security
control whose correctness rests on our own parser agreeing with every browser's.
Rejected.

**`dompurify` + `jsdom`.** DOMPurify is the reference implementation and is what
most of the industry trusts in a browser. On a server it needs a DOM, and
`jsdom` is a full browser-grade one: tens of megabytes of dependencies and a
per-call cost measured against a document, all to sanitise a paragraph.
It is also more surface than the job needs — a `window` per call in a process
that also drains queues. Rejected for v1; it stays the fallback if
`sanitize-html` is ever the wrong shape.

**`sanitize-html` (2.17.7, MIT).** Purpose-built for exactly this: a server-side,
allowlist-first sanitiser over `htmlparser2`, with per-tag attribute lists,
per-tag URL scheme lists, `nonTextTags` for elements whose *content* must go
with them, and no DOM. It is what the same job uses in most Node codebases, it is
actively maintained, and it needs nothing at runtime but the parser.

## Decision

`sanitize-html@2.17.7`, pinned exactly, as a dependency of `@helpdock/channels`,
with `@types/sanitize-html@2.16.1` for the types.

It lives in `packages/channels/src/html/` rather than in the api, because
sanitising is a *channel* concern: M2-07 ("Email security: sanitized HTML
allowlist, no scripts or forms") is the same code on the same bodies, and M4 and
M6 bring two more channels that need it. `apps/api` already depends on
`@helpdock/channels`.

The policy on top of the library is stricter than its own defaults and is
documented where it is written (`sanitize.ts`):

- an allowlist of tags with no `<form>`, `<input>`, `<button>`, `<iframe>`,
  `<object>`, `<embed>`, `<svg>`, `<math>`, `<style>` or `<link>`;
- a ceiling of **6,000 opening tags** per body, counted on the raw input before
  the parser sees it, and deliberately a conservative over-count. The
  library's cost is super-linear in *nesting depth* rather than in size:
  `'<b>'.repeat(66_000)` is under two hundred kilobytes and takes seconds, while
  the same number of bytes of prose takes two milliseconds. Sanitising is
  synchronous and runs inside the request's open database transaction, so a
  length cap alone would leave a way to stall a replica;
- an allowlist of attribute *names* per tag, which is what keeps every `on*`
  handler out whatever tag it is written on, and which excludes `style` (so CSS
  `expression()` and `position: fixed` have nowhere to live) and `class` (so a
  message cannot restyle the page around it);
- link schemes `http`, `https`, `mailto`, `tel`, with protocol-relative URLs
  refused, so `javascript:` loses its attribute rather than its page;
- `rel="noopener noreferrer nofollow"` written onto every surviving `<a>`,
  whatever it arrived with, and `target` normalised to `_blank` when one is
  present: `noopener` stops a target page reaching back through `window.opener`,
  `noreferrer` stops the ticket's URL leaking to whatever a customer linked, and
  `nofollow` stops the help center being a link farm for whoever emails it;
- **absolute URLs only**, on both `href` and `src`. A scheme allowlist is
  applied only to a URL that *has* a scheme, so `src="/pixel.gif"`, `src="p.gif"`
  and `href="/settings/delete"` all survive one. A relative URL in a message
  from a stranger resolves against whatever page renders it, which makes it a
  read receipt fired by the reader's own browser against the desk's own origin,
  or a link that looks like a genuine in-app link. Both are dropped;
- `<img src>` limited to `cid:` by default — a remote image is a read receipt
  the recipient did not ask for, and in the admin it is a request from the
  desk's network to an address a stranger chose. `imageSrc: 'allow-remote'` is
  the toggle §5.1 asks for; M2-07 puts a per-brand switch and a proxy behind it;
- form controls are `nonTextTags`, so a phishing button's label does not survive
  as bare text.

`body_text` is extracted from the **sanitised** html by the same module, so the
text can never be derived from a body the sanitiser has not seen.

## Consequences

- One more direct dependency, MIT-licensed, with `htmlparser2` and `postcss`
  beneath it. Renovate keeps it current; it is a security control, so a release
  of it is a release worth taking promptly.
- The sanitiser is not a parser we own, so a CVE in it is a CVE in Helpdock. The
  allowlist above is narrow enough that the classes of bug it has historically
  had — attribute smuggling through tags we do not allow — are mostly out of
  reach, and `packages/channels/src/html/sanitize.test.ts` is the regression
  suite.
- A body above the tag ceiling is refused with 400 rather than truncated. A
  legitimate message that hits it does not exist today; if one ever does, the
  number is a constant with a test beside it.
- Bodies are stored sanitised and never re-sanitised on read, so tightening the
  allowlist later does **not** retroactively clean stored rows. A future
  tightening that matters for security needs a migration job over
  `ticket_messages`, which is why the sanitiser is idempotent and has a test
  saying so.
- If `dompurify` + `jsdom` is ever needed — richer content, a mutation-XSS
  finding — it replaces the functions in `packages/channels/src/html/` behind
  the same signatures.
