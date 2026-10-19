# Changelog

What changed in each release of Helpdock, written for the person deciding
whether to upgrade — one section per release. The per-change list, with a link
to the pull request that carried each one, is `apps/api/CHANGELOG.md`, which
Changesets writes from the entries in `.changeset/` when it opens the version
pull request.

A section's heading is `## <version> — <date>`, and
[the release workflow](.github/workflows/release.yml) copies it into the GitHub
Release for the matching `v<version>` tag. [`docs/guides/release.md`](docs/guides/release.md)
is the procedure.

Versions follow [semantic versioning](https://semver.org). Before 1.0 a minor
bump may change behaviour; upgrade notes call it out when it does.

## 1.0.0 — 2026-10-19

The first stable release. Every milestone of the 1.0 plan has shipped: the
ticket desk with SLAs, rules and macros; email, Telegram, WhatsApp, Messenger
and Instagram, the chat widget and the web form; a bilingual help center on
each brand's own domain; grounded AI that assists agents and answers customers
from the brand's knowledge; the REST API, webhooks and reports; staff sign-in
over SAML and OpenID Connect; and importers from Zendesk, Freshdesk and Zoho
Desk with a manual CSV mapper for the rest. What each milestone built, and the
gaps it left open, is in [docs/completed/](docs/completed/README.md).

### Upgrading from 0.7

Nothing to change in your configuration. The major version marks the release,
not an incompatible change: follow
[Upgrading](docs/guides/operations.md#upgrading) with `1.0.0`, and the api runs
any pending migrations when it starts.

### Before the release

- **Release gates.** The external pentest of the widget and the API, the load
  run on the reference host, the screen-reader pass, the onboarding run on a
  clean VM with three outside testers, and the restore drill were completed
  before 1.0.0. Their results are held by the maintainer and are not published
  in this repository.
- **OWASP ASVS Level 2.** Every requirement has been walked with its evidence,
  and no gap is open ([asvs-l2](docs/completed/asvs-l2.md)).

### Known limits

- **SSO and imports were not run against live accounts.** Sign-in was verified
  against stand-in OIDC and SAML identity providers, and the Zendesk, Freshdesk
  and Zoho Desk importers against stand-in servers built from each vendor's
  published API documentation. No run against a live Okta or Entra ID tenant
  or a live vendor account was made before 1.0.
- **More importers come later.** Help Scout, Intercom, Gorgias, Zammad and
  Front connectors are deferred; until then their exports go through the manual
  CSV mapper ([importing](docs/guides/importing.md)).

## 0.5.1 — 2026-10-13

A fix release for two admin defects that only show against a real api, so the
mock-backed test suites never caught them. No migration, configuration or API
change; upgrade by pulling the new image.

- **Agent assist works in the production admin again.** Since 0.4.0 the
  composer's Assist menu (suggest reply, summarize, suggest fields, translate,
  rewrite, draft article), the "items redacted before AI" notice, voice-note
  transcripts and Help center › Proposals called `/api/api/…`, got a 404 and
  stayed hidden. They now reach the api ([#175](https://github.com/Docker-Hunterpedia/Helpdock/pull/175)).
- **The "is viewing" indicator names colleagues for Agents.** An Agent, who
  cannot read the staff list, saw part of a user id ("01a13522 is replying").
  Names now come from the department's assignable list, as the assignee picker's
  do ([#175](https://github.com/Docker-Hunterpedia/Helpdock/pull/175)).

## 0.5.0 — 2026-10-13

**M10 Meta channels**, and the code half of **M9 Hardening**: the fixes from
the internal pre-pentest review, the gaps the ASVS L2 re-walk of Telegram, AI
and the API found, the automated accessibility audit, and four follow-ups M6
and M7 had left open. What still needs a person before 1.0 is listed under
known gaps.

### M10 Meta channels

- **WhatsApp numbers, Facebook Pages and Instagram professional accounts are
  ticket channels.** A customer's message opens a ticket or continues the
  conversation's open one, and an agent's public reply, text and files, goes
  back on the same platform through the outbox. Images, video, documents,
  voice notes and stickers arrive on the ticket; locations and shared
  contacts are filed as text. The first message of a reply opens with the
  agent's first name and the brand.
- **One webhook for the install.** Every post from Meta is checked against
  the app secret before it is parsed, routed to the account it names, filed
  within the request and answered at once. Channels › Meta shows the callback
  URL and the verify token to paste into Meta's dashboard.
- **Connect an account per platform on Channels › Meta** by pasting the
  dashboard's token, test it before saving and route it to a department.
  Once an hour a job checks the token and the webhook subscription; the
  account's page offers **Subscribe now** and **Reconnect** when Meta drops
  either.
- **The reply window.** A reply outside Meta's 24-hour window is refused when
  it is written, and the ticket view says how long the window stays open. A
  person's reply to a Messenger or Instagram customer between 24 hours and
  7 days goes out with Meta's Human Agent tag when the account's switch is
  on.
- **Delivery states on every reply:** sent, delivered and read as Meta
  reports them, `failed` with Retry, and `refused` in Meta's words when the
  window had closed.
- **Identities.** The ticket view shows which number, Page or account a
  ticket is with, the customer's platform id, phone, name or handle, and
  which of them is verified. Messenger and Instagram names are looked up by
  a job and kept once they arrive.
- The whole of it is in
  [`docs/guides/meta-channels.md`](docs/guides/meta-channels.md): what each
  platform needs, what Meta charges for WhatsApp, App Review, and developing
  without Meta.

### M9 Hardening

- **Visitor addresses behind a proxy.** `TRUST_PROXY` now takes a list of
  proxy addresses, CIDRs or the names `loopback`, `linklocal` and
  `uniquelocal`, so the api believes the hop from Caddy and not an address a
  client wrote into `X-Forwarded-For`. The Cloudflare Caddyfile trusts
  Cloudflare's published ranges and forwards the visitor's address.
- **Widget sockets** spend a budget of 120 events a minute per visitor, and a
  visitor's sockets are closed when their signed identity is withdrawn or
  changed.
- **OAuth sign-in** is bound to the browser that started it by a ten-minute
  cookie.
- **API keys can expire** (`expiresAt` when one is created), a refused key
  leaves a trace in the audit log, an API key gets 403 instead of 500 on
  routes that act for a person, and `webhooks:manage` no longer reads data on
  its own.
- **Brands scheduled for deletion.** During the 30-day grace, the brand's API
  keys answer 410 and its webhook deliveries are skipped.
- **Model addresses are checked when saved:** https, and no private, loopback
  or metadata address unless its range is in `OUTBOUND_ALLOW_CIDRS`.
- **Retention** purges finished webhook deliveries and sent or failed Telegram
  replies after 30 days, and stored `Idempotency-Key` answers after 24 hours.
  "Anonymise contact" also erases the contact's Telegram chats, the redaction
  maps of AI calls on their tickets and the webhook deliveries that carry
  their data.
- **Uploaded and Google Drive DOCX files** are refused past 1,000 entries or
  100 MiB unpacked. JSON answers carry `Cache-Control: no-store`. A Notion or
  Google Drive connection callback works once.
- **Accessibility.** Zoom, reflow, forced colours, screen-reader markup and
  mixed-direction text are checked by Playwright on the widget and the help
  center in both languages, and what they found is fixed
  ([record](docs/completed/accessibility-audit.md)). The ASVS L2 record
  reads 198 Met, 35 Partial and 0 Gap ([record](docs/completed/asvs-l2.md)).

### Gaps closed from M6 and M7

- **Telegram bots have their own language prompt.** `/start` asks for English
  or Arabic with the bot's question, edited on the bot's page under
  Channels › Telegram.
- **The widget's handoff line says when the team is back.** A visitor writing
  out of hours after a handoff reads when the team is away until, by the
  department's calendar, else the brand's. A conversation carries the new
  optional `hours`.
- **The ticket list says what the assistant did.** A row's caption ends with
  "AI paused" or "AI answered".
- **Agent assist sends the brand's Arabic system prompt** for an Arabic
  ticket, as auto-reply already did.

### Upgrade notes

- Run the migrations (`0048`–`0052`). Restart the worker so it picks up the
  Meta jobs (sending, media, profile names and the hourly health check).
- **The Compose file now sets `TRUST_PROXY=uniquelocal`** instead of `true`.
  `true` still works and still believes every hop. Behind Cloudflare, copy the
  new `docker/caddy/Caddyfile.cloudflare` and run `docker compose up -d`
  ([install guide](docs/guides/install.md#behind-cloudflare)); behind a proxy
  of your own, list its address
  ([install guide](docs/guides/install.md#behind-a-proxy-of-your-own)).
- **API keys that manage webhooks need the read scope of the endpoint's
  events** (`tickets:read`, `contacts:read` or `articles:read`), or they get
  403 `webhook-event-scope`. Endpoints that already exist keep delivering.
- Keys already issued never expire; set `expiresAt` through the API when you
  want one to.
- A Google or GitHub sign-in begun just before the upgrade has to be started
  again.
- To connect a Meta account, set the Meta app's id and secret in `.env`
  (`HD_META_APP_ID`, `HD_META_APP_SECRET`) and restart the api and the worker;
  there is no Meta section on the Settings screen in this release
  ([the four settings](docs/guides/meta-channels.md#the-four-settings)).
  Optional: `META_GRAPH_VERSION`, `META_GRAPH_API_ROOT` and
  `META_INSTAGRAM_API_ROOT`, whose defaults are Meta's.

### Known gaps

- **The Meta channels have not been run against a real Meta app yet.** CI
  uses a stand-in for the Graph API. The milestone document lists what only a
  real run settles: which secret signs Instagram webhooks (both are tried),
  the exact closed-window error code, whether Business Verification is
  required for App Review, and whether a Page the operator administers returns
  a customer's name without the profile feature. Until an install has been
  through App Review, a Messenger contact can be "Messenger user" with its
  id.
- **WhatsApp templates** (M10-09), which reach a customer after the window,
  come in a later release; the satisfaction survey is not sent on these
  channels until they do.
- **What still needs a person before 1.0:** the external pentest
  ([scope](docs/planning/pentest-scope.md)), the screen-reader pass
  ([runbook](docs/guides/screen-reader-pass.md)), the load-test host run, the
  clean-VM onboarding run with outside testers, and the restore drill for the
  record ([M9](docs/in-development/M9-hardening-and-1-0.md)).
- The rest is listed in
  [M10](docs/completed/M10-meta-channels.md#gaps-accepted-up-front).

## 0.4.0 — 2026-10-08

**M6 Telegram**, **M7 AI** and **M8 API, webhooks and reports**, and the code
side of M9 that shipped with them: the ASVS L2 walk-through, Semgrep rules,
the ZAP baseline, the SBOM, the user guides under `docs/guides/`, and the
load, onboarding and restore tooling.

### M6 Telegram

- **Telegram bots are a channel.** Add a bot on Channels › Telegram with its
  token, test it, route it to a department and set the webhook in one press.
  Customers write to the bot and get a ticket; agents answer from the ticket
  view, with files, and see whether Telegram accepted each reply, with Retry
  when it did not. Photos, documents, voice notes and locations arrive on the
  ticket, and `/start` asks for English or Arabic. For development, long
  polling stands in for the webhook (`TELEGRAM_POLLING`).

### M7 AI

- **Providers and models.** Connect a provider in the first-run wizard or on
  AI › Providers with an API key, subscription credentials or none for a
  local OpenAI-compatible server, stored encrypted and never returned; pick
  the chat model and the install's one embedding model.
- **Knowledge.** Build a brand's knowledge on AI › Knowledge from its
  articles, files, a crawl, Notion or Drive, each public or internal, on a
  schedule, with a sync log.
- **Agent assist and auto-reply.** Suggested replies with citations,
  summaries, suggested fields, translation, tone, and a draft article a Team
  Leader approves; customers get grounded answers with sources and a
  one-press handoff that pauses the assistant. Per channel, with a threshold,
  a handoff message and a system prompt in both languages.
- **Guardrails.** PII redaction before every model call, an injection filter,
  a daily and monthly budget, and every call logged with its tokens and cost.
  Voice notes get a transcript. `pnpm eval:ai` scores the assistant on the
  fixture set.

### M8 API, webhooks and reports

- **Scoped API keys and REST v1** on Admin › Developers, documented at
  `/api/docs`.
- **Signed outbound webhooks**, with every delivery readable, replay, ping
  and secret rotation.
- **Reports** over any range, by department, channel and agent, each
  exportable as CSV.
- **The System page:** version, migrations, queues with Bull Board, every
  channel's health, storage per brand, LLM spend and the product metrics.
- **Satisfaction surveys** on the channel a ticket used.
- **Brand deletion** with a 30-day grace and restore.

### Fixes

- The offline auto-unassign waits for the department to open, the first-run
  wizard generates the web push key pair, the widget names the agents online,
  staff socket events have per-person budgets, and signing out of one browser
  closes only that browser's sockets.
- Install authentication settings with write-only OAuth credentials,
  nonce-based admin styles, a restrictive browser permissions policy, and the
  Fastify HTTP/2 trailer-response denial of service patched.

### Upgrade notes

- Run the migrations (`0036`–`0047`). Restart the worker so it picks up the
  Telegram, AI and report jobs.
- New optional keys: `TELEGRAM_POLLING`, `TELEGRAM_API_ROOT`,
  `KNOWLEDGE_CRAWL_RENDER`, `AUTH_SESSION_IDLE_MINUTES`,
  `AUTH_SESSION_MAX_HOURS` and `OUTBOX_CONCURRENCY`. Their defaults are in
  `.env.example` and the [configuration guide](docs/guides/configuration.md).
- From this release the image's digest is signed; the
  [release guide](docs/guides/release.md#verify-the-image-signature) has the
  `cosign verify` command. `v0.4.0` itself was signed on 2026-10-09, after it
  was published.

### Known gaps

Listed in [M6](docs/completed/M6-telegram.md#gaps-and-follow-ups),
[M7](docs/completed/M7-ai.md#gaps-and-follow-ups) and
[M8](docs/completed/M8-api-webhooks-reports.md#gaps-and-follow-ups). The ones
to know before turning the assistant on: the quality thresholds have not been
shown met by a real provider (the nightly evaluation needs a key), there is no
streaming, and a budget alert lands in the audit log only.

## 0.3.1 — 2026-09-28

- New widget signing secrets start with `hdws_` instead of `whsec_`, the
  prefix Stripe uses for its webhook secrets, so secret scanners no longer
  report a Helpdock secret as a Stripe key. Secrets generated earlier keep
  working; replace one only if you want the new prefix.

## 0.3.0 — 2026-09-28

**M4 Widget and realtime** and **M5 Help center**. Customers can now reach the
desk from a brand's own website: an embeddable chat widget, a hosted contact
form, and a bilingual help center on the brand's domain whose articles the
widget searches too.

### M4 Widget and realtime

- **The chat widget.** One `<script type="module" … data-brand>` tag. It is a
  Preact app in a Shadow DOM, about 26 KB gzipped, with socket.io loaded only
  when a conversation starts. It has four modes (chat, chat with suggested
  articles, help center only, and contact form), light, dark and auto themes
  from the brand's accent, and English and Arabic with right-to-left layout.
- **Visitor identity and ownership.** A server-issued visitor id and a hashed
  secret. An optional signed identity comes from the customer's own backend. A
  typed email never opens another contact's conversations.
- **Origin allow-list and rate limits** on every widget route and on the socket
  handshake. They are set on Channels › Widget.
- **Delivery you can trust.** Messages are deduplicated by client id, carry a
  sequence number per conversation, and catch up after a reconnect, with an SSE
  fallback. A dropped network, an api restart or a double send leaves exactly
  one message.
- **In the widget:** a pre-chat form, business-hours awareness, the transcript
  by email, agent name and avatar, and attachments and voice notes within the
  brand's content policy.
- **The hosted web form** at `/contact`, per brand, with custom fields,
  attachments and optional CAPTCHA (Turnstile or hCaptcha). It needs no
  JavaScript.
- **The widget protocol** is documented for native apps in
  [`docs/guides/widget-protocol.md`](docs/guides/widget-protocol.md).

### M5 Help center

- **Content:** categories, sections and articles with an English and an Arabic
  version, drafts, scheduled publishing, and a fallback to the brand's default
  language. The admin editor handles headings, tables, callouts, code, images
  (re-encoded to WebP), YouTube and Vimeo embeds, and Markdown import and
  export.
- **Visibility:** each version is public or internal, and a whole help center
  can be internal-only. Internal content never reaches the sitemap, public
  search or a public cached page. Staff reach it through a one-minute pass from
  the admin.
- **Pages on the brand's own domain.** Custom domains are checked by CNAME and
  TXT and get certificates from Caddy on demand. Pages are server-rendered in
  both languages and cached, with canonical and hreflang links, Open Graph,
  JSON-LD, a sitemap and `robots.txt`.
- **Theme:** accent colour, logo, favicon, home layout, header and footer
  links, and custom CSS, which is filtered through a strict allowlist.
- **Search** in English and Arabic with typo tolerance on titles, plus a search
  log that shows what customers looked for and did not find.
- **Feedback:** views and "Was this helpful?" votes, and an Insights tab. From
  an article, "Still need help?" opens the widget or the form and tells the
  agent which article the customer came from.

### Fixes

- A brand added after setup now gets the built-in ticket statuses. Before this
  release no ticket could be filed in it, and its widget said it was
  unavailable.

### Upgrade notes

- Run the migrations (`0030`–`0035`). Restart the worker so it picks up the
  help center jobs (publishing, image processing, search indexing).
- The image now carries the widget build and serves it at `/widget.js`. Set
  `WIDGET_DIST_DIR` only when you run the api outside the image.
- Optional: `HELPCENTER_CNAME_TARGET` names the host customers' help center
  domains should point at. It defaults to the host of `APP_URL`. The install
  guide's [custom domains](docs/guides/install.md#custom-domains) section has
  the DNS steps.
- The bundled `Caddyfile` changed. If you keep your own copy, compare it: a
  domain marked as proxied by Cloudflare no longer triggers a certificate
  request.

### Known gaps

Listed in [M4](docs/completed/M4-widget-and-realtime.md) and
[M5](docs/completed/M5-help-center.md). The one to know before exposing a help
center: images in internal articles are not access-controlled beyond an
unguessable address.

## 0.2.0 — 2026-09-27

**M2 Email channel** and **M3 Automation and SLAs**. Helpdock now talks to
customers by email and runs the desk on its own: business hours and SLA clocks,
workflow and time-based rules, macros and canned responses, and staff
notifications in the admin, by email and by browser push.

### M2 Email channel

- **Inbound email** from IMAP mailboxes or inbound-parse webhooks (Postmark,
  SendGrid, Mailgun, Resend, generic JSON). Replies thread onto their ticket by
  `Message-ID`, `References` or the ticket number, and only when the sender is a
  participant — anyone else quoting a ticket gets a new ticket.
- **Outbound email** through each brand's SMTP server, from the department's
  address, in English or Arabic with the agent's signature. Every send goes
  through the outbox with a fixed `Message-ID`, retries five times, and lands in
  **Failed sends** in the admin when it cannot be delivered.
- **Auto-replies** (acknowledgment and out-of-hours) with loop protection.
- **Email security**: sanitised HTML, remote images blocked or proxied, an
  optional SPF/DKIM spam rule.

### M3 Automation and SLAs

- **Business hours and holidays** per brand, with department overrides.
- **SLA engine**: first-response and resolution clocks in business time, pause
  on "awaiting customer", escalation steps, and timers rebuilt after a Redis loss.
- **Workflow rules** on events and on a schedule, with a test run and a loop
  guard; **macros and canned responses** in English and Arabic.
- **Notifications** in the admin, by email and by web push, with per-person
  preferences; an **audit log** viewer for install admins.

### Upgrade notes

- Run the migrations (`0024`–`0029`); the worker needs a restart to pick up the
  new queues.
- **Sign-in links, password resets and invitations are now emailed** through the
  install's SMTP server (the wizard's outgoing email step). Before this release
  they were only logged. Without SMTP they are still not delivered; the install
  guide says how to use Mailpit in development.
- Optional: `HD_PUSH_VAPID_PUBLIC_KEY` and `HD_PUSH_VAPID_PRIVATE_KEY` turn on
  browser push notifications.

### Known gaps

Listed in [M2](docs/completed/M2-email-channel.md) and
[M3](docs/completed/M3-automation-and-slas.md); none blocks upgrading.

## 0.1.0 — 2026-09-27

The first release: **M0 Skeleton** and **M1 Ticketing core**. Helpdock is now a
working staff ticket desk — brands, departments and teams, tickets with a full
workspace, contacts, views and search — behind the tenancy, auth and install
foundations of M0. Customers cannot reach it yet: there is no email channel,
help center or widget. Pre-alpha: expect breaking changes before 1.0.

### M1 Ticketing core

- **Brands, departments and teams.** Ticketing settings per brand, departments
  with an Arabic name and a default team, and team members scoped to the
  departments they can reach.
- **Tickets under department scope.** Tickets, messages, internal notes and an
  activity log under row-level security that hides a department's tickets from
  anybody outside it. Every change reaches open screens in real time.
- **One state machine** for every status change, with a per-brand reopen policy,
  "awaiting customer" on an agent reply, and escalation.
- **The ticket workspace.** List, thread, composer, details panel and new-ticket
  dialog, in English and Arabic, with a collision indicator when two agents are
  on the same ticket.
- **Saved views and search.** Personal and shared views with sidebar counts, and
  ticket search through a token table (ADR 0011), so a search that finds nothing
  stays fast under row-level security.
- **Contacts and accounts**, with verified-only automatic merging, duplicate
  suggestions and a 24-hour undo.
- **Desk tools.** Tags, custom fields and templates; round-robin and skill-based
  assignment; merge (with a 24-hour unmerge) and split; spam and a sender block
  list; time tracking; CSAT rating links; attachments with a media pipeline that
  re-encodes images, voice notes and video posters.
- **Retention.** Per-brand retention with a nightly purge and contact
  anonymisation.

### Upgrade notes

- **New, optional: `HD_SETUP_TOKEN`.** When set (at least 32 characters), the
  first-run wizard asks for it as a "Setup key" before it creates the admin
  account, so nobody who cannot read the server's `.env` can claim a fresh
  install. Set it before the host is reachable from the internet. Unset, the
  wizard behaves as before. See [the install guide](docs/guides/install.md).
- Development MinIO now comes from Chainguard's public image.

### Security

- The first-run wizard can be gated by `HD_SETUP_TOKEN` (above).
- Fixes for the first CodeQL findings: remote response headers can no longer
  write to an object prototype, the SMTP deadline is capped at ten seconds, and
  an admin asset path is proven to be inside the build before the file system is
  touched.

### M0 Skeleton

The foundation every later milestone builds on: an install you can stand up,
sign in to and watch.

- **One deploy, many brands, enforced in Postgres.** Every tenant table carries
  `brand_id` under a `FORCE`d row-level-security policy, every request runs
  inside a transaction that sets the `app.*` session settings, and every route
  declares the permission it needs. A negative test suite proves brand A cannot
  read brand B.
- **Install and run with Docker Compose.** One image with `APP_ROLE=api|worker`,
  a Compose stack with Caddy, Postgres 17 with pgvector, Redis and MinIO, and
  on-demand TLS that only answers for a verified help-center domain.
- **A first-run wizard.** A brand-new install lands on four steps: the admin
  account, the first brand, outgoing email, done.
- **Four ways to sign in.** Password (argon2id), sign-in link, Google and
  GitHub, each with TOTP and recovery codes, rotating refresh tokens in Redis
  and "sign out everywhere".
- **Staff and roles.** Admin, Team Leader, Agent and the Viewer toggle, with
  invite, activate, role change, deactivate, reactivate, delete and per-brand
  removal.
- **An admin shell in English and Arabic**, right-to-left included, with the
  System page reporting version, commit, queues and dependency health.
- **The plumbing later milestones need**: a Socket.IO `/staff` namespace with
  presence, a transactional outbox with a crash-safe relay, an SSRF-safe
  outbound HTTP client, pino logs with request and brand ids, OpenTelemetry and
  `/metrics`.

### Not in this release

Email, automation and SLAs, the help center, the widget, the Telegram channel,
AI and the public API. They are M2 to M8 in [the PRD](docs/planning/PRD.md).
