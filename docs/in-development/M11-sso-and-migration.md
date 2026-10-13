# M11 SSO and migration

Status: in development
Started: 2026-10-13
Owner: @Docker-Hunterpedia

## Scope

Two things decide whether a team that pays for Zendesk, Freshdesk or Zoho Desk
today can move to Helpdock: **its staff signing in the way they already do**, and
**its ticket history coming along intact**. Features do not move a team on day
one; a migration that does not hurt does. This milestone builds both, for 1.0.

**Single sign-on for staff.** An install admin connects one or more identity
providers over **SAML 2.0** or **OpenID Connect** (Okta, Microsoft Entra ID,
Google Workspace, Keycloak, JumpCloud, OneLogin, Authentik, any standard IdP).
A person signs in with "Continue with <IdP>", or types their work email and is
sent to the right IdP. Accounts are created on first sign-in (just-in-time
provisioning) from verified IdP claims, and IdP groups map to Helpdock roles,
brands and departments, re-applied at every sign-in. SSO can be enforced for the
whole install, with a break-glass install admin who keeps a password and a second
factor. SCIM provisioning is out of scope (backlog).

**A real import path.** A brand admin moves a helpdesk into a brand with a
wizard: connect the old tool, choose what to bring, map its statuses, groups,
agents and fields to Helpdock's, run a **dry run** that reports exactly what will
happen, then import. Tickets arrive with their full thread in order, original
authors and dates, public replies and internal notes, attachments, tags, custom
fields, assignees and satisfaction ratings; contacts, companies and help-center
articles come along. **Nothing leaves the install while importing**: no email,
no Telegram or Meta send, no webhook, no rule, no SLA timer, no AI call. Reports
show the history on its original days. A second run is a **delta sync** that
brings over what changed since the last one, which is how a team cuts over
without losing a reply.

Sources:

- **Connectors** for every helpdesk whose API can export a whole account: Zendesk,
  Freshdesk and Zoho Desk in this milestone; Help Scout, Intercom, Gorgias,
  Zammad and Front on the same connector SDK, marked "may ship after 1.0".
- **A manual mapper** for everything else: upload CSV files (or a Helpdock
  import bundle) and map their columns to Helpdock's fields on screen, with
  presets saved for the next file.

Every source, connector or file, produces the same normalised records, and one
engine maps, validates and loads them. A connector is therefore a thin adapter,
not a second importer.

The request came from user feedback in [#180](https://github.com/Docker-Hunterpedia/Helpdock/issues/180). This is a scope change: until this milestone both were v1.1 backlog items
(REQUIREMENTS §6, PRD §5: "Custom roles and permission sets; SAML/OIDC SSO",
"Importers: Zoho Desk, Zendesk, Freshdesk"). The owner moved them into 1.0
(PRD change log, 2026-10-13). 1.0.0 (M9-09) now waits for M11's exit criteria.
SCIM and custom roles stay in the backlog. The designs are
[ADR 0026](../decisions/0026-staff-sso-over-saml-and-oidc.md) and
[ADR 0027](../decisions/0027-imports-through-one-normalised-record-engine.md).

Full deliverable list: [PRD §4 · M11](../planning/PRD.md#m11-sso-and-migration).
Depends on: M0 (auth, settings, outbox, SSRF-safe client), M1 (tickets,
contacts, attachments), M3 (SLA, rules), M5 (help center), M8 (reports). Built
from the artboards listed under [Artboards to draw](#artboards-to-draw) and
[DESIGN.md](../../DESIGN.md).

### How to work this milestone (for the implementing agent)

Read [AGENTS.md](../../AGENTS.md) first; its rules apply to every deliverable
here. In particular:

1. **All remaining M11-07–23 deliverables share one pull request (owner instruction); related deliverables may share a pull request** (owner approved larger PRs on 2026-10-13), in the order of [Build order](#build-order),
   each linking its GitHub issue (`Closes #n`) and following the Definition of done:
   unit tests, integration tests for anything touching Postgres, Redis, queues or
   a vendor, Playwright in `en` and `ar` for every screen, docs in the same PR.
2. **Never improvise a screen.** Build from the named artboard. If a state is
   missing from the artboard, stop and ask; do not invent layout.
3. **New dependencies** only those listed in ADR 0026 / 0027, at the versions
   there, after checking them again with Context7 at the time of the PR.
4. **Vendor API facts in this document are a starting point, not a contract.**
   The first task of every connector is to read the vendor's official API
   documentation and correct the connector's notes section below in the same PR
   (endpoints, pagination, rate limits, field names). Several limits here come
   from secondary sources and are marked *verify*.
5. **Every new tenant table** goes into `TENANT_TABLES` (`packages/db/src/rls.ts`),
   `pnpm --filter @helpdock/db gen:rls`, and a fixture in
   `packages/db/src/rls.integration.test.ts`. Install-scope tables (SSO) do not;
   they are reached only through `install:admin` routes and the sign-in path, and
   say so in a comment on the table.
6. **No outbound call to a user-supplied URL** except through `safeFetch`
   (`@helpdock/net`), DOMAIN-RULES §13.

## Deliverables

Estimates are working days for one experienced contributor, Definition of done
included. Ids M11-01 to M11-18 are the 1.0 scope; M11-19 to M11-23 are further
connectors on the same SDK and **may ship after 1.0**.

| Id | Deliverable | Spec | Tests beyond unit | Estimate | Issue | Status |
|---|---|---|---|---|---|---|
| M11-01 | SSO schema, settings and the shared SSO service: `sso_connections`, `sso_role_mappings`, `user_sso_identities` (install scope), `user_brand_roles.source`, the `sso.*` settings, `SsoService` (connection CRUD, secret encryption, the SP signing key, the Redis request store), audit events | A §7; R §5.1; ADR 0026 (1–4) | Integration: CRUD, secrets never returned, key generated once under a lock | 3 d | #183 | done |
| M11-02 | OIDC sign-in: discovery and JWKS through `safeFetch` (`customFetch`), authorization code + PKCE + `state` + `nonce`, ID token validation, claims mapping, `GET /api/auth/sso/:id/start`, `GET /api/auth/sso/:id/oidc/callback` | ADR 0026 (5) | Integration against the fake OIDC IdP: happy path, wrong nonce, replayed state, unverified email, expired token, issuer mismatch | 3 d | #184 | done |
| M11-03 | SAML sign-in: `@node-saml/node-saml`, SP metadata, signed AuthnRequest, ACS with signed assertion required, `InResponseTo` store in Redis, audience/recipient/time checks, IdP certificate rotation (several certs), optional IdP-initiated | ADR 0026 (6) | Integration against the fake SAML IdP: happy path, unsigned assertion, wrong audience, replayed response, expired assertion, IdP-initiated off | 4 d | #185 | done |
| M11-04 | Sign-in integration: `AuthService.completeSso`, account linking, JIT provisioning, group→role sync at every sign-in, `idpEnforcesMfa`, enforcement with break-glass, home-realm discovery by email domain, invite acceptance through SSO, error codes | A §7; D §1; ADR 0026 (7–10) | Integration: link by verified email in an allowed domain only; JIT creates user + memberships; a group removed in the IdP removes the SSO-sourced role at next sign-in; enforcement refuses password, magic link and OAuth except break-glass | 4 d | #186 | done |
| M11-05 | Admin: Settings › Single sign-on (connections list, add/edit OIDC and SAML, role mappings, Test connection, enforcement), sign-in screen SSO buttons and email-first discovery, Staff list "SSO" badge | R §4.10; DESIGN §6 | Playwright `en`/`ar` on mock api; real-api browser spec signing in through the fake OIDC and SAML IdPs | 4 d | #187 | done |
| M11-06 | SSO docs: `docs/guides/sso.md` (Okta, Entra ID, Google Workspace, Keycloak walk-throughs), authentication guide, configuration guide, `.env.example` | AGENTS.md DoD 1 | `docs-guard` | 1.5 d | #188 | done |
| M11-07 | Import schema: `import_runs`, `import_records`, `import_mappings`, `import_external_ids`, `import_log` (tenant tables, RLS), `tickets.imported_at`, `tickets.import_source`, `attachments.origin`, `csat_answer_channel` value `import`, the `import` queue | A §5, §13; ADR 0027 (1–3) | Integration: RLS negative suite; migration round-trip | 2 d | #189 | in progress |
| M11-08 | Normalised import records and the bundle format: Zod schemas in `packages/schemas/src/import.ts` for users, contacts, organisations, groups, fields, tickets, messages, attachment refs, tags, CSAT, categories, sections, articles; the Helpdock import bundle (zip of NDJSON + attachments) and its validator | ADR 0027 (2) | Schema tests over fixtures from all three vendors | 2 d | #190 | in progress |
| M11-09 | The loader: `ImportWriter` writes tickets, messages, activity, tags, participants, contacts, identities, accounts, CSAT and help-center rows directly, with no lifecycle hooks and no outbox events except media processing and one `help_center.imported`; idempotent through `import_external_ids`; original dates kept; report rollups rebuilt over the imported range | D §2, §4, §7; ADR 0027 (4–8) | Integration on Testcontainers: a 500-ticket bundle loads; a second load writes nothing; the outbox holds only `attachment.uploaded` and `help_center.imported`; no email, rule run, SLA clock, notification or webhook delivery exists afterwards; reports count the history on its original days | 5 d | #191 | in progress |
| M11-10 | Import jobs: `import.extract`, `import.load`, `import.attachments`, `import.finish` on the `import` queue; resumable cursors, 429 back-off from `Retry-After`, cancel, pause, progress counters, per-line log, dry run, delta sync, credential purge on finish | A §13; ADR 0027 (9) | Integration: kill the worker mid-load and resume without duplicates; a 429 delays the job by `Retry-After`; cancel stops within one batch; delta brings only changed tickets | 3 d | #192 | in progress |
| M11-11 | Connector SDK and stand-ins: `packages/importers` (new workspace), the `Connector` interface, the rate limiter, `safeFetch` with a vendor host allow-list, attachment fetching, and a stand-in server per vendor for tests | ADR 0027 (10) | The stand-ins' own suites | 2 d | #193 | in progress |
| M11-12 | Zendesk connector: API token or OAuth; incremental tickets, users, organisations; groups, fields, comments, attachments, satisfaction ratings, Help Center; mapping defaults | ADR 0027 (10) | Integration against the Zendesk stand-in: a full extract and a delta; 429 handling; archived ticket comments | 4 d | #194 | planned |
| M11-13 | Freshdesk connector: API key; tickets, conversations, contacts, companies, agents, groups, fields, satisfaction ratings, Solutions; mapping defaults | ADR 0027 (10) | Integration against the Freshdesk stand-in, full and delta | 3.5 d | #195 | planned |
| M11-14 | Zoho Desk connector: OAuth per data centre, `orgId`; tickets, threads, comments, contacts, accounts, agents, departments, Knowledge Base; mapping defaults | ADR 0027 (10) | Integration against the Zoho Desk stand-in, full and delta | 4 d | #196 | planned |
| M11-15 | The manual mapper: upload CSV files or a bundle, detect columns, map them to Helpdock fields with transforms (date format, split name, status values), preview 20 rows with validation, save and reuse mapping presets | ADR 0027 (2, 11) | Integration: a CSV with odd dates and a quoted multiline body imports; a preset re-applies; Playwright `en`/`ar` | 4 d | #197 | planned |
| M11-16 | Admin: Brand › Import: runs list, the wizard (source, connect, scope, map, dry run, import, done), progress with log, pause/cancel, delta sync, the dry-run report | R §4.10; DESIGN §6 | Playwright `en`/`ar` on mock api for every step and failure state; real-api browser spec importing from the Zendesk stand-in | 6 d | #198 | planned |
| M11-17 | Imported tickets in the workspace: header chip "Imported from Zendesk · #1234" with the source link, the `ticket.imported` activity line, the "Source" filter in views, the System page's Import card | DESIGN §6.3 | Playwright `en`/`ar` | 1.5 d | #199 | planned |
| M11-18 | Import docs: `docs/guides/importing.md` (per vendor, the manual mapper, the bundle format, the cutover runbook), retention and reports guides, PRD and this doc | AGENTS.md DoD 1 | `docs-guard` | 2 d | #200 | planned |
| M11-19 | Help Scout connector (Mailbox API 2.0: conversations, threads, customers, Docs) | ADR 0027 (10) | Stand-in, full and delta | 3 d | #201 | later (may ship after 1.0) |
| M11-20 | Intercom connector (conversations, conversation parts, contacts, companies, Articles) | ADR 0027 (10) | Stand-in, full and delta | 3.5 d | #202 | later (may ship after 1.0) |
| M11-21 | Gorgias connector (tickets, messages, customers) | ADR 0027 (10) | Stand-in, full and delta | 2.5 d | #203 | later (may ship after 1.0) |
| M11-22 | Zammad connector (tickets, articles, users, organisations, knowledge base) | ADR 0027 (10) | Stand-in, full and delta | 2.5 d | #204 | later (may ship after 1.0) |
| M11-23 | Front connector (conversations, messages, comments, contacts) | ADR 0027 (10) | Stand-in, full and delta | 3 d | #205 | later (may ship after 1.0) |

Total for the 1.0 scope (M11-01 to M11-18): about **63 working days** for one
person; SSO (M11-01 to 06) and import (M11-07 to 18) are independent and can run
in parallel, which brings the calendar to roughly 6–7 weeks with two people.

## Exit criteria

Each is proved by a named test against the stand-ins (fake OIDC and SAML IdPs,
vendor stand-in servers) on real Postgres and Redis (Testcontainers), as M6 and
M10 were. A run against real IdPs and real vendor accounts is recorded in this
document by the owner (external dependencies), but is not a CI gate.

- [ ] A staff member signs in through an OIDC IdP and through a SAML IdP with
      "Continue with …" and with email-first discovery; the first sign-in creates
      the account and its brand memberships from the IdP's groups; a group
      removed in the IdP removes the matching SSO role at the next sign-in.
- [ ] With SSO enforced, password, magic link and Google/GitHub sign-in are
      refused for everyone except the break-glass install admin, and an invite is
      accepted through SSO.
- [ ] A Zendesk, a Freshdesk and a Zoho Desk account (stand-ins seeded with the
      same reference dataset: 500 tickets, 2 000 messages, attachments, notes,
      CSAT, 50 contacts, 10 companies, 20 articles in two languages) import into a
      brand with every ticket's thread, authors, dates, notes, attachments, tags,
      custom fields and assignee intact.
- [ ] During and after an import, the install sent nothing: the stand-in SMTP,
      the webhook receiver, the Telegram and Graph stand-ins received no request;
      no `workflow_runs`, `ticket_sla_clocks`, `notifications`, `ai_calls` or
      `webhook_deliveries` rows reference an imported ticket.
- [ ] Reports for the imported range show the imported volume, first response,
      resolution and CSAT on their original days.
- [ ] Running the same import again writes nothing; a delta run brings only the
      tickets changed since; killing the worker mid-load and resuming loses and
      duplicates nothing.
- [ ] A CSV export from a tool without a connector imports through the manual
      mapper with a saved preset.
- [ ] Brand A cannot read brand B's import tables (DOMAIN-RULES §1.6 negative
      suite); vendor credentials are never returned after save and are deleted
      when a run finishes.
- [ ] The SSO and Import screens pass Playwright in `en` and `ar` with axe.

## Migrations

Numbers continue from `0052`. Each migration has its round-trip test, as every
earlier one.

- `0053_sso` (M11-01): `sso_connections`, `sso_role_mappings`,
  `user_sso_identities`; `brand_role_source` enum (`manual`, `sso`) and
  `user_brand_roles.source` default `manual`, `sso_connection_id`, and a provenance check constraint.
- `0054_imports` (M11-07): `import_runs`, `import_records`, `import_mappings`,
  `import_external_ids`, `import_log`, `import_file_presets`, their RLS policies (`gen:rls`);
  `ticket_messages.author_display varchar(200) null` (the name shown for an
  imported agent kept as "name only");
  `tickets.imported_at timestamptz`, `tickets.import_source text`;
  `attachment_origin` enum (`upload`, `channel`, `import`) and
  `attachments.origin` default `upload` (backfilled `channel` where
  `uploader_type = 'system'`); `csat_answer_channel` value `import`.

## Open questions

**Should an imported ticket that is still open get an SLA?** Default proposed:
no clocks for imported tickets, closed or open; the Import screen's last step
offers "Start SLA clocks for the N open imported tickets now", which calls
`SlaService.sync` for them and starts the clocks at that moment. *Status (2026-10-13): default approved by the owner in the implementation instruction.*

**Should imported tickets keep the old tool's numbers?** Default proposed: no.
Every imported ticket gets a new number from the brand's sequence; the old number
is shown on the "Imported from …" chip and is searchable. Keeping numbers is
offered only when the brand has no tickets yet, the brand prefix is chosen to
match, and no vendor number collides; the loader then `setval`s the sequence
past the highest. *Status: default approved by the owner in the implementation instruction.*

**Are imported agents created as staff?** Default proposed: the Map step offers,
per vendor agent, "Map to an existing person", "Create an invited person" (no
email is sent; the admin sends invites later from Staff), or "Keep as a name
only" (messages are authored by a placeholder system author with the agent's
name in `author_display`). *Status: default approved by the owner in the implementation instruction.*

**Do SSO roles override manual ones?** Default proposed: no. A membership has a
`source`; the sync at sign-in adds and removes only `sso` memberships and never
touches `manual` ones. An admin who edits an SSO membership by hand turns it
`manual`. *Status: default approved by the owner in the implementation instruction.*

## Artboards to draw

Drawn by the orchestrating session on the [design canvas](https://claude.ai/artifact/RQd32d1RXK8DST8SKC1VBQ) before the screens are
built (AGENTS.md, design first); sources in `docs/design/artboards/`, snapshots in `docs/design/screens/m11/`. Sign-in is drawn in both languages as `Admin/Login`
was; the admin screens in English, with the RTL rules of DESIGN §7.

| Artboard | For | Must show | Status |
|---|---|---|---|
| `Admin/Settings-SSO` | M11-05 | The Single sign-on tab: connections table (name, protocol, domains, status, last sign-in), enforcement card with break-glass picker, empty state | Drawn 2026-10-13, as on the canvas |
| `Admin/Settings-SSO-Connection` | M11-05 | The connection page: OIDC and SAML variants, SP values to copy (callback/ACS, entity ID, metadata URL), IdP fields, attribute and group claim, domains, JIT and MFA switches, role-mapping table, Test connection result panel (claims shown) | Drawn 2026-10-13, as on the canvas |
| `Admin/Login-SSO`, `Admin/Login-SSO-AR` | M11-05 | Sign-in with SSO buttons, email-first discovery ("Continue" sends you to Okta), enforced state where only SSO shows, the break-glass link | Drawn 2026-10-13, as on the canvas |
| `Admin/Import` | M11-16 | Brand › Import: runs table (source, started, status, counts), "New import" with source picker (connectors + Manual file), empty state | Drawn 2026-10-13, as on the canvas |
| `Admin/Import-Wizard` | M11-16 | Steps 1–4 with StepProgress: Connect (credentials, Test), Scope (date range, entities, help center), Map (statuses, priorities, groups→departments, agents→staff, fields, tags), Dry run report | Drawn 2026-10-13, as on the canvas |
| `Admin/Import-Run` | M11-16, M11-17 | Running import (progress per entity, live log, pause/cancel), done summary with warnings, delta-sync button, "Start SLA clocks" offer | Drawn 2026-10-13, as on the canvas |
| `Admin/Import-FileMapper` | M11-15 | Upload, detected columns, mapping table with transforms, 20-row preview with row errors, save preset | Drawn 2026-10-13, as on the canvas |
| `Admin/Ticket-Imported` | M11-17 | The ticket header chip "Imported from Zendesk · #1234", the `ticket.imported` activity line | Drawn 2026-10-13, as on the canvas |

Additional M11-05 UI states absent from the artboards: loading/network/save
errors, invalid form values, unsaved-test hint, blocked popup, invitation password
form hidden under enforcement, protected preview refusal and Arabic settings.
These use existing DESIGN components and the artboards' form/table patterns.

## Gaps accepted up front

Written down before the work starts, so nobody discovers them in review.

| Gap | Why |
|---|---|
| **No SCIM.** Deactivating someone in the IdP takes effect at their next sign-in attempt (refused) or when an admin deactivates them; existing Helpdock sessions live until they expire (12 h at most). | SCIM is a protocol and a test matrix of its own; it stays in the backlog. The session ceiling bounds the exposure. |
| **No single logout (SLO).** Signing out of Helpdock does not sign out of the IdP, and an IdP logout does not end Helpdock sessions. | SLO is rarely relied on and doubles the SAML surface. |
| **SSO is for staff only.** Customers sign in to the help center and widget as before (signed identity, M4). | Customer SSO is a different product decision. |
| **One SP signing key per install**, not per connection. | Simpler rotation; IdPs that need per-connection keys are rare. |
| **Side conversations, Zendesk/Freshdesk macros, automations, SLA policies and views are not imported.** Their meaning does not survive translation; the guide lists them as "rebuild by hand". | Importing rules that behave differently is worse than importing none. |
| **Call recordings, chat transcripts stored outside tickets, and community forums are not imported.** | Not ticket history in Helpdock's model. |
| **Articles in languages other than English and Arabic are skipped** with a warning; Helpdock has two locales (D §5). | Locale scope of v1. |
| **Attachments the vendor no longer serves** (expired, deleted, private without access) are skipped with a log line and a placeholder note on the message. | Nothing to fetch. |
| **History older than 400 days is imported but not in reports** unless the admin chooses "Rebuild all reports" (a longer job). | The rollup's normal backfill window (M8). |
| **Contact merges and duplicate suggestions are not created by the import.** An imported email that already belongs to a contact attaches to that contact; anything ambiguous is logged, not merged. | Merging is a human decision (M1-13). |
| **Vendor API limits make large imports slow.** Zendesk's incremental export allows about 10 requests a minute (*verify*); 100 000 tickets take hours. The progress screen says so and the job runs unattended. | The vendors' limits. |

## External dependencies

| Dependency | Status | What waits on it |
|---|---|---|
| Developer tenants of Okta and Microsoft Entra ID (free developer plans) with a test user in two groups | `needed` ([PRD](../planning/PRD.md#external-dependencies)) | The recorded real-IdP runs in this document; the guide's screenshots |
| A Google Workspace or Keycloak instance for the third walk-through | `needed` | `docs/guides/sso.md` |
| Trial accounts of Zendesk, Freshdesk and Zoho Desk seeded with the reference dataset | `needed` | The recorded real-vendor runs; correcting the connectors' notes against reality |

## Build order

1. M11-01 → M11-02 and M11-03 (parallel) → M11-04 → M11-05 → M11-06.
2. M11-07 → M11-08 → M11-11 → M11-09 → M11-10 → M11-12 → M11-16 (on the Zendesk
   connector) → M11-13, M11-14, M11-15 (parallel) → M11-17 → M11-18.
3. Tracks 1 and 2 are independent. M11-19 to M11-23 follow, after 1.0 if need be.

---

## M11-01 SSO schema, settings and the shared service

Artboards: none (no screen).

**Database** (`packages/db/src/schema/sso.ts`, migration `0053_sso`). Install-scope
tables, like `users`: not in `TENANT_TABLES`, read and written only by
`install:admin` routes and by the sign-in path, each with a header comment saying
so (AGENTS.md, tenancy).

```
sso_connections
  id uuid pk (v7)
  name varchar(80) not null            -- the button label: "Okta", "Acme Entra"
  protocol sso_protocol not null       -- enum: oidc | saml
  enabled boolean not null default false
  email_domains text[] not null default '{}'   -- lower-case, for discovery and linking
  jit_enabled boolean not null default true
  idp_enforces_mfa boolean not null default false
  default_access jsonb null            -- { brandId, role, departmentIds|null } or null = deny without a mapping
  group_attribute varchar(200) null    -- OIDC claim / SAML attribute holding groups
  config jsonb not null                -- protocol-specific, non-secret (below)
  secret_encrypted text null           -- OIDC client secret, AES-256-GCM v1 envelope
  last_sign_in_at timestamptz null
  created_at, updated_at, created_by uuid fk users
  unique (lower(name))

sso_role_mappings
  id uuid pk
  connection_id uuid fk sso_connections on delete cascade
  idp_group varchar(300) not null      -- exact group value from the IdP
  brand_id uuid fk brands on delete cascade
  role brand_role not null
  department_ids uuid[] null           -- null = all departments (team_leader/admin); agents need a list
  position int not null                -- first match per brand wins
  unique (connection_id, idp_group, brand_id)

user_sso_identities
  id uuid pk
  user_id uuid fk users on delete cascade
  connection_id uuid fk sso_connections on delete cascade
  subject varchar(300) not null        -- OIDC sub / SAML NameID
  email_at_link varchar(320) not null
  linked_at, last_sign_in_at timestamptz
  unique (connection_id, subject)

user_brand_roles.source brand_role_source not null default 'manual'  -- manual | sso
user_brand_roles.sso_connection_id uuid null fk sso_connections on delete restrict
  -- non-null exactly for an SSO membership; one owning connection per user/brand
```

`config` by protocol (Zod in `packages/schemas/src/sso.ts`, `ssoConnectionConfigSchema`
discriminated on `protocol`):

- OIDC: `{ issuer: url, clientId, scopes: string[] (default ['openid','email','profile']), emailClaim: 'email', nameClaim: 'name', requireEmailVerified: true }`.
- SAML: `{ idpEntityId, idpSsoUrl: url, idpCertificates: string[] (PEM, 1–3, for rotation), idpMetadataUrl?: url, nameIdFormat: 'emailAddress'|'persistent'|'unspecified', emailAttribute?: string, nameAttribute?: string, signAuthnRequests: true, allowIdpInitiated: false, clockSkewSeconds: 60 }`.

**Settings** (`packages/config/src/registry.ts`, install scope):

| Key | Schema | Default | Secret | Meaning |
|---|---|---|---|---|
| `sso.enforced` | boolean | `false` | no | Password, magic link and OAuth refused for everyone not in `sso.breakGlassUserIds` |
| `sso.breakGlassUserIds` | uuid[] (max 3) | `[]` | no | Install admins who keep password + TOTP while SSO is enforced; each must have TOTP enabled (validated on save) |
| `sso.spPrivateKey` | text | `''` | yes | The SP's RSA-2048 key, generated on first use under a Redis lock, like `auth.jwtSigningKey` |
| `sso.spCertificate` | text | `''` | no | Self-signed cert for the key, 10-year validity, shown in SP metadata |

**`SsoService`** (`apps/api/src/sso/sso.service.ts`, module `apps/api/src/sso/sso.module.ts`):

- `list()`, `get(id)`, `create(input)`, `update(id, input)`,
  `remove(id)` with the install-admin actor from request context; the client secret is accepted on write and never returned
  (`secretConfigured: boolean` instead), exactly as the OAuth settings do.
- `spKeys()` returns `{ privateKey, certificate }`, generating both once:
  RSA-2048 with asynchronous Node WebCrypto key generation, and a self-signed
  certificate built with `@peculiar/x509` (2.1.0 at planning time; ADR 0026),
  because `node:crypto` can parse X.509 but cannot issue one.
- `requestStore`: Redis-backed, keys `auth:sso:req:<sha256(id)>`, TTL 10 min,
  `put`, `consume` (GETDEL, atomic). Used for OIDC `state` and SAML
  `InResponseTo`.
- Audit (install scope, ADR 0022): `sso.connection.created|updated|deleted|enabled|disabled`
  (keys changed, never values), `sso.settings.updated`.

**Routes** (`apps/api/src/sso/sso-admin.controller.ts`, all `@Requires('install:admin')`):

| Method | Path | Body / response |
|---|---|---|
| GET | `/api/install/sso/connections` | `ssoConnectionListSchema` |
| POST | `/api/install/sso/connections` | `ssoConnectionCreateSchema` → `ssoConnectionSchema` |
| GET | `/api/install/sso/connections/:id` | `ssoConnectionSchema` (+ `sp`: `{ entityId, acsUrl, metadataUrl, oidcRedirectUri }`) |
| PUT | `/api/install/sso/connections/:id` | `ssoConnectionUpdateSchema` (secret optional: absent keeps) |
| DELETE | `/api/install/sso/connections/:id` | 204; linked connections are refused with `409 sso-connection-in-use`; refused with `409 sso-enforced-last` if it is the last enabled connection while enforced |
| PUT | `/api/install/sso/connections/:id/mappings` | the whole mapping list, replaced |
| POST | `/api/install/sso/connections/:id/test` | M11-02/M11-03: `{ startUrl }` for a test sign-in that does not open a session |
| GET/PUT | `/api/install/sso/settings` | `{ enforced, breakGlassUserIds }` with locked flags |

The SP identity is install-wide: entity ID `${APP_URL}/api/auth/sso/saml/metadata`,
per-connection ACS `${APP_URL}/api/auth/sso/<id>/saml/acs`, OIDC redirect
`${APP_URL}/api/auth/sso/<id>/oidc/callback`.

**Tests.** Unit: schemas, config validation (an IdP URL that is not https is refused
unless its host resolves inside `OUTBOUND_ALLOW_CIDRS`, as AI providers). Integration:
CRUD; secret encrypted at rest and absent from every response; key generation
happens once across two concurrent callers; audit rows.

### M11-01 implementation notes

Master-key rotation includes the encrypted OIDC client secret and the SP private
key setting. The real-Postgres rotation suite verifies both remain decryptable
with the replacement key alone; migration-runner expectations include `0053_sso`.


Issue #183; implementation branch `feat/m11-01-sso-schema`.

Migration `0053_sso` adds the three install-scope tables and membership
provenance, preserving existing rows as manual. The tables are explicitly
classified in `GLOBAL_TABLES`; existing membership RLS remains enforced.
Connection CRUD, detail URLs, mapping reads/replacement, and settings reads/
updates are installed under `/api/install/sso`, each guarded by `install:admin`
and validated/serialized through shared Zod DTOs. Client secrets are encrypted
and only `secretConfigured` is returned. Audit rows contain field names only.
The protocol start/callback/test routes belong to M11-02/M11-03; no placeholder
sign-in URL is exposed by this foundation.

Enforcement configuration requires an active break-glass install admin with a
password, enabled TOTP and a stored TOTP secret. Connection disabling and
removal share the settings transaction lock, so concurrent requests cannot
remove every enabled provider. Authentication integration is still M11-04;
setting the configuration here does not change existing sign-in methods yet.

Settings and SP keys use uncached transaction reads to avoid stale control
state. Key/certificate generation commits atomically under a database lock in
addition to the ownership-safe Redis lease. A linked connection's identity
authority cannot change; mappings validate active brands and department
ownership. Protocol-specific request-store namespaces have ten-minute TTLs and
atomic GETDEL consumption across replicas. ADR 0026 is accepted with amendments
covering these corrections and the requirements for later protocol work.

Tests cover encrypted CRUD and audit, authorization and input failures,
cross-brand mapping rejection, enforced-provider concurrency, immutable linked
identity authority, certificate validation, concurrent key generation, request
expiry/replay, membership isolation, and migration rollback/reapplication over
existing manual memberships. This deliverable adds no screen.

## M11-02 OIDC sign-in

Implementation uses **`openid-client` 6.8.8**, verified against npm and the
[official API reference](https://github.com/panva/openid-client/tree/v6.8.8/docs)
on 2026-10-13. A provider client must allow authorization code, PKCE S256 and
`client_secret_post` (or an explicitly public client when no secret is saved).

- Discovery, token exchange, JWKS and UserInfo use the same `customFetch`
  adapter over `safeFetch`: 10-second deadline, 1 MB body cap and **zero
  redirects**. HTTP is permitted only for addresses explicitly allowed by
  `OUTBOUND_ALLOW_CIDRS`; discovered endpoints also receive destination checks.
  Cached discovery expires after one hour and is keyed by the current database
  configuration revision. Disabled providers and changed configuration are
  checked again at callback, across replicas.
- **Signature validation is explicitly enabled** with
  `enableNonRepudiationChecks`. In this authorization-code flow the library
  otherwise relies on token-endpoint TLS and does not require ID-token JWS
  validation. The fake-IdP suite proves a correctly formed token signed by an
  untrusted key is rejected.
- `GET /api/auth/sso/:id/start?returnTo=...` is public with a 20/minute/IP budget.
  It stores random state, nonce, PKCE verifier, connection/configuration binding,
  browser-nonce hash and validated local return path in Redis for ten minutes.
  The per-connection cookie is HttpOnly, host-only and SameSite=Lax. HTTPS uses
  `__Host-hd_sso_<id>`, Secure and Path=/ to prevent sibling-domain cookie
  planting. Local HTTP uses `hd_sso_<id>` scoped to the connection's auth path. `test=1` is rejected until M11-06 adds the protected
  connection-test flow; it must never accidentally create a session.
- `GET /api/auth/sso/:id/oidc/callback` has a 40/minute/IP budget, atomically
  consumes state, checks the browser and configuration, validates PKCE, state,
  nonce, issuer, audience, expiry and signature, and clears the nonce cookie.
  The callback is built from `APP_URL`, never Host/forwarded headers. Responses
  are not cached; completion redirects also suppress the referrer.
- Verified email and subject come only from the validated ID token.
  `email_verified` must be boolean `true`. Subject-checked UserInfo can supplement
  name/groups, never email or verification. Configured groups may be a string
  or string array. Missing/malformed groups and Entra overage claims are refused
  with a safe warning, so an unknown list cannot remove SSO grants. Distributed
  claim URLs are never fetched.
- `AuthService.completeSso` currently accepts **already-linked subjects only**,
  preserves existing manual roles and local TOTP, and uses the existing refresh
  cookie / one-time exchange-code completion flow. No email auto-linking, JIT or
  group sync occurs in this deliverable; M11-04 extends that shared completion
  method. The validated return path is carried through the protocol handoff;
  the current completion UI still lands on Tickets. M11-05 adds the SSO login UI.

The API fake IdP lives in `apps/api/src/testing/fake-oidc-idp.ts`; its browser
counterpart is `apps/admin/e2e/api/fake-oidc.ts`, without cross-app imports.
They implement discovery, authorization-code/PKCE, RSA-signed ID tokens, JWKS
and subject-checked UserInfo, with controls for token attacks, private JWKS and
307 redirects. The RSA stand-in matches the library's default RS256 client
algorithm instead of the plan's original ES256 fixture.

Tests: unit claim/return-path boundaries and shared completion; real-Postgres
and Redis integration against the fake IdP (including full HTTP session handoff,
state concurrency, rate limiting, configuration changes and token attacks);
Playwright happy/failure paths in `en` and `ar`, with axe. Browser fixtures
pre-link the existing seeded account explicitly and preserve its local TOTP.

An optional **real Keycloak 26.8.0 Docker smoke test** complements CI's fake
attack suite. It imports a disposable realm, drives Keycloak's real login page
in Chromium, then validates its authorization code, signed subject, verified
email and groups through Helpdock and refuses replay. Run:

```sh
pnpm --filter @helpdock/api exec playwright install chromium
HD_TEST_KEYCLOAK=1 pnpm exec vitest run --project integration apps/api/src/sso/oidc-keycloak.integration.test.ts
```

This needs free loopback ports 8443 (Keycloak) and 3126 (callback capture), plus
Docker. Testcontainers removes the realm and containers afterwards. The fake
IdP/browser fixture uses port 8080. These runs prove protocol interoperability;
real-install JIT and IdP MFA policy remain M11-04 / M11-18 validation.

## M11-03 SAML sign-in

**Verified 2026-10-13:** npm reports `@node-saml/node-saml` **5.1.0**.
The [published version's documentation](https://github.com/node-saml/node-saml/blob/v5.1.0/README.md)
and installed implementation were checked before implementation. The supported
cache interface is `saveAsync` / `getAsync` / `removeAsync`; it has no
`consumeAsync`. `idpIssuer` validates logout messages, so Helpdock additionally
checks the issuer and recipient in the authenticated assertion XML.

Dependencies are pinned: node-saml 5.1.0, its lockfile `xml-crypto` 6.3.3,
`xml-encryption` 3.1.0 and parser 0.8.15. Helpdock's boundary parser uses
`@xmldom/xmldom` 0.9.12, whose scoped types avoid leaking browser globals into
the server build. Explicit XML dependencies own parsing/cryptography already
approved by ADR 0026. Browser fixtures use the same approved signing libraries.

- **SP metadata:** public `GET /api/auth/sso/saml/metadata`, one stable install
  entity ID (the metadata URL), signing/encryption certificates, and one indexed
  HTTP-POST ACS for every enabled SAML connection. It advertises signed
  AuthnRequests, signed assertions and AES-GCM encryption. No SLO is advertised.
- **Start:** shared `GET /api/auth/sso/:id/start` dispatches by the enabled
  connection's protocol. HTTP-Redirect AuthnRequests are signed RSA-SHA256,
  request the configured NameID format and the exact configured ACS. The
  front-channel endpoint passes the outbound destination policy before redirect.
  Request IDs and opaque RelayState are random; ten-minute Redis state binds
  connection, configuration revision, signed request ID, return path and browser
  nonce. HTTPS uses a host-prefixed HttpOnly Lax nonce cookie; local HTTP uses
  the existing connection-scoped cookie.
- **ACS:** public `POST /api/auth/sso/:id/saml/acs`, URL-encoded body capped at
  256 KiB and validated with Zod. Signed assertions are mandatory; a signed
  response alone is insufficient. Node-saml validates signatures/audience and
  correlated request times; Helpdock reads only `getAssertionXml()` after
  verification and additionally checks issuer, bearer confirmation, recipient,
  NameID format, mandatory validity windows, signed correlation and duplicate
  attributes. Assertion age is capped at ten minutes; configured skew is 0–60
  seconds. UTC and offset timestamps, including submillisecond fractions, are
  accepted. DTDs/entities, ambiguous children and malformed XML are refused.
- **Cryptographic policy:** inbound signatures/digests use RSA SHA-256 or
  SHA-512. Encrypted assertions require AES-128/256-GCM and RSA-OAEP;
  decrypted XML passes the same boundary and signature validation. Legacy SHA-1
  signatures, CBC and RSA1.5 encryption are refused. The RSA-OAEP MGF1P
  algorithm's SHA-1 padding digest is separate from the signature policy.
- **Replay:** connection-scoped Redis cache implements the actual published
  library interface. After validation a Lua claim atomically reserves the signed
  assertion ID and request ID for twelve minutes, beyond the maximum assertion
  age plus skew. Concurrent callbacks cannot both finish. Library `get`/`remove`
  alone is not the replay authority.
- **Browser handoff:** ACS creates a single-use ten-minute pending assertion and
  returns 303 to `GET /api/auth/sso/:id/saml/complete?token=...`. The GET receives
  the Lax cookie and atomically consumes pending/request state before checking
  the browser nonce, signed request ID and current configuration revision.
  ACS never opens a session or requires a cookie on the cross-site POST. Failed
  callbacks use the existing translated completion screen; successful callbacks
  preserve local TOTP and the refresh-cookie / one-time exchange flow.
- **Claims:** persistent NameID is the subject. Configured `emailAttribute`
  supplies email, otherwise NameID must be an email address; the domain must be
  explicitly listed in `emailDomains`. A configured group attribute must be
  present and contain strings; missing groups refuse sign-in. M11-04 owns JIT,
  email linking, group-role sync and IdP MFA. Only existing subject bindings
  complete sessions in this PR. `test=1` remains refused until M11-06.
- **Optional IdP initiation:** disabled by default. When enabled, a validated
  unsolicited assertion is replay-claimed, then starts a fresh browser-bound
  SP round trip. The second assertion must name the same subject. The
  unsolicited response never opens a session directly; arbitrary RelayState
  cannot choose a redirect or bypass browser binding.
- **IdP metadata:** optional URL fetched through safeFetch on save and by the
  daily `sso.metadata_refresh` maintenance job (04:45 UTC), re-registered on
  worker boot. Entity ID, Redirect SSO URL and one to three RSA signing
  certificates (at least 2048 bits) must match the configured provider. A
  refresh only applies a set overlapping a current certificate, under the
  configuration lock and revision check. Dropping every trusted certificate
  keeps the old set and writes `sso.metadata.rotation-refused` with
  `admin-confirmation-required`. An admin confirms by explicitly saving the
  new certificate set; failed fetches write sanitized audit warnings. Identical
  refreshes do not rewrite configuration.

**Stand-ins:** `apps/api/src/testing/fake-saml-idp.ts` and
`apps/admin/e2e/api/fake-saml.ts`, disposable RSA certificates, verify actual
SP redirect signatures and issue signed responses. Integration controls cover
unknown/rotated certificates, wrapping, forged attributes, issuer/audience/
recipient, expiry/future/missing timestamps, missing groups, duplicate
attributes, encryption, replay, unsolicited responses and metadata rotation.
No test calls a live IdP.

**Validation:** focused unit tests for XML/crypto/input boundaries; real
Postgres/Redis protocol, metadata and HTTP integration; en/ar real-api
Playwright happy/failure flows with axe and local TOTP. Reuses existing
completion/TOTP artboards; no new UI state. Real Okta/Entra/Google SAML runs
remain later milestone acceptance evidence, not claimed by stand-in tests.

## M11-04 Sign-in integration

`AuthService.completeSso(assertion, { userAgent, test })` (`apps/api/src/auth/auth.service.ts`)
beside `completeOauth`. Steps:

1. **Find the link**: `user_sso_identities` by `(connection, subject)`.
2. **Else link by email**, only when the email is verified (OIDC claim, or SAML
   domain rule) **and** its domain is in `email_domains`: an existing user with
   that email (case-insensitive) is linked; audit `sso.user.linked`.
3. **Else JIT** (if `jit_enabled`): compute memberships from mappings (step 4);
   none and no `default_access` → refuse `sso-no-access`; otherwise create the
   user `active` (no password), insert `user_sso_identities`, insert memberships
   with `source='sso'`; audit `sso.user.provisioned`. JIT off → `no-account`.
4. **Sync roles** at every SSO sign-in: for each brand, the first mapping
   (by `position`) whose `idp_group` is in the assertion's groups gives the role
   and departments; `default_access` applies if none match for its brand. Upsert
   `sso` memberships that differ, delete `sso` memberships whose brand no longer
   matches; never touch `manual` ones. A user left with no memberships at all →
   `sso-no-access` (and the account is not deactivated; the admin decides).
   Audit `sso.roles.synced` with before/after roles only when something changed.
   Sessions of this user are revoked when a role was removed
   (`sessions.revokeEverything`, as role edits do).
5. **Update** `name` from the IdP if changed, `last_sign_in_at` on identity and connection.
6. **Second factor**: if `idp_enforces_mfa`, the SSO sign-in counts as both
   factors (method `sso`, `secondFactor: 'idp'`); otherwise
   `#afterFirstFactor(user, { method: 'sso' })` applies Helpdock TOTP as today.
   `auth.require2fa` and the admin rule are satisfied by `idp_enforces_mfa`.
7. **Test mode** (`test=1`): steps 1–4 are computed but not written; the callback
   renders `/admin/settings/sso/:id?test=<key>` where the admin sees the claims,
   the matched user (or "would be created"), and the roles that would apply.

`SignInMethod` gains `'sso'`; `authErrorCodes` gains `sso-email-unverified`,
`sso-no-access`, `sso-connection-disabled`, `sso-required`, `sso-invalid-response`
(all with en/ar copy in `packages/i18n/locales/*/auth.json`).

**Enforcement.** When `sso.enforced`, `signIn` (password), `requestMagicLink`,
`consumeMagicLink`, `completeOauth` and invite acceptance with a password refuse
local methods with `sso-required`; only configured break-glass admins can use
password plus fresh TOTP. Discovery is a separate rate-limited public route,
not account data attached to a sign-in refusal.
Saving `enforced: true` requires at least one enabled connection, and every
break-glass user to be an install admin with TOTP enabled. Turning enforcement on
does not revoke sessions; the sign-in rules apply from the next sign-in.

**Home-realm discovery.** `POST /api/auth/sso/discover { email }` (`@Public`,
rate-limited like sign-in) answers `{ connections: [{ id, name }] }` for the
email's domain, or `[]`. It never says whether the account exists.

**Invites.** An invited user whose email domain matches an enabled connection
sees "Continue with <IdP>" on the invite screen; completing SSO with that email
accepts the invite after required factors through `SsoIdentityService.acceptInvitation`;
its audit and pending-token cleanup complete without setting a password. The
invitation membership stays `manual`.

`GET /api/auth/methods` gains `sso: [{ id, name }]` (enabled connections) and
`ssoEnforced: boolean`.

**Tests.** Integration on Testcontainers with both fake IdPs: link, JIT, sync
add/remove/keep-manual, no-access, test mode writes nothing, enforcement matrix
(password/magic/OAuth refused; break-glass allowed), discovery, invite through SSO,
`idp_enforces_mfa` true/false with a TOTP-enabled user, session revocation on role
removal.

## M11-05 Admin: single sign-on

Artboards: `Admin/Settings-SSO`, `Admin/Settings-SSO-Connection`,
`Admin/Login-SSO`, `Admin/Login-SSO-AR`.

**The admin client** (`apps/admin/src/sso/`): `api.ts` (interface + keys),
`http-api.ts`, `mock-api.ts`, `context.tsx`, registered in `auth/select-api.ts`
and `app/providers.tsx`, following `apps/admin/src/meta/`.

**The screens**

| File | What |
|---|---|
| `src/screens/admin/settings/sso-tab.tsx` | The new "Single sign-on" tab beside Authentication in `settings-page.tsx`: connections table, enforcement card |
| `src/screens/admin/settings/sso-connection-page.tsx` | Route `ROUTES.ssoConnection` (`/admin/settings/sso/:id`): form per protocol, SP values with copy buttons (SecretReveal is not used; these are public), role mappings table (group, brand, role, departments), Test connection and its result panel |
| `src/screens/sign-in.tsx` | SSO buttons from `authMethods.sso`; when `ssoEnforced`, the email field first: Continue → `discover` → redirect, or the break-glass password link |
| `src/screens/accept-invite.tsx` | "Continue with …" for a matching connection |
| `src/screens/admin/staff/*` | An "SSO" badge on people with an identity link; SSO-sourced memberships read-only with "Managed by <IdP>" |

i18n keys in `packages/i18n/locales/{en,ar}/sso.json` and additions to `auth.json`.

**Tests.** Unit for forms and adapters. Playwright (`apps/admin/e2e/sso.spec.ts`,
`en`/`ar`, axe): add an OIDC and a SAML connection, mappings, enforcement with
break-glass validation errors, sign-in buttons, discovery. Real api
(`apps/admin/e2e/api/sso.api.spec.ts`): sign in through the fake OIDC IdP and the
fake SAML IdP (stand-ins on new ports, e.g. 3098 and 3099), JIT then role sync.

## M11-06 SSO docs

`docs/guides/sso.md`: concepts (JIT, mappings, enforcement, break-glass,
`idp_enforces_mfa`), the values to copy into each IdP, walk-throughs for Okta,
Entra ID, Google Workspace (SAML) and Keycloak (OIDC), troubleshooting by error
code, certificate rotation. Updates: `authentication.md` (methods, enforcement),
`staff-and-roles.md` (sources), `configuration.md` (the `sso.*` keys and their
`HD_SSO_*` env pins), `.env.example`, `security.md` (SAML threat notes). ARCHITECTURE
§7 gets an SSO paragraph and §1 the two library rows.

### M11-04–06 implementation notes (merged)

Related deliverables share one owner-approved PR. Identity linking/JIT/sync,
uncached enforcement/discovery, invitation completion and actor-owned protected
previews are implemented. Settings save connection and mappings atomically using
`POST /api/install/sso/configurations` and
`PUT /api/install/sso/connections/:id/configuration`. Targets expose only public
SP URLs and eligible admin/brand/department selection data. See ADR 0026 amendments.

Gaps reproduced and fixed: manual staff edits retained SSO ownership; a racing
sign-in could mint stale roles during removal; token registration could happen
behind family revocation; configured long sessions exceeded the SSO ceiling;
JWTs could outlive their family; React effect replay double-spent an exchange code;
SQL lock ordering could deadlock staff edits against SSO; disabled Viewer policy
could leave an unusable JIT account; SSO invitations retained pending links; malformed
issuer input threw during safe validation. Regression tests cover these paths.
Sign-in reports safe protocol error codes and preserves local return paths through
TOTP enrolment. No new dependency or tenant table is added in this batch.

PR #212 merged after all CI checks passed, including unit/coverage, real
infrastructure integration, EN/AR browser and real-API browser suites. Real
external-provider acceptance remains owner-run, as documented in the SSO guide.

## M11-07 Import schema

**Database** (`packages/db/src/schema/imports.ts`, migration `0054_imports`). All
tenant tables (brand_id + forced RLS), added to `TENANT_TABLES` and the negative
suite.

```
import_runs
  id uuid pk, brand_id
  source import_source not null        -- zendesk | freshdesk | zohodesk | helpscout | intercom | gorgias | zammad | front | file
  mode import_mode not null            -- full | delta
  parent_run_id uuid null              -- the full run a delta continues
  status import_status not null        -- draft | connecting | extracting | awaiting_mapping | dry_run | ready | loading | finishing | completed | failed | cancelled | paused
  options jsonb not null               -- scope: { since, until, entities[], helpCenter, keepNumbers, startSla, statuses[] … }
  credentials_encrypted text null      -- vendor credentials, v1 envelope; nulled on completed/failed/cancelled
  cursors jsonb not null default '{}'  -- per entity: vendor cursor or page
  counts jsonb not null default '{}'   -- extracted: { entity: unique staged count }; load progress is separate
  dry_run_report jsonb null
  error text null
  started_by uuid fk users
  created_at, started_at, finished_at, updated_at, claimed_at
  claim_token uuid null, paused_from import_status null
  unique (brand_id) where claim_token is not null

import_records                          -- the staging area, one row per normalised record
  id uuid pk, brand_id, run_id fk import_runs on delete cascade
  entity import_entity not null        -- user | contact | organization | group | field | tag | ticket | message | attachment | csat | category | section | article
  external_id varchar(200) not null
  parent_external_id varchar(200) null -- message → ticket, article → section …
  payload jsonb not null               -- the normalised record (M11-08)
  payload_hash char(64) not null       -- sha256 of canonical JSON, for delta
  status import_record_status not null default 'staged'   -- staged | loaded | skipped | failed
  helpdock_id uuid null
  error text null
  unique (run_id, entity, external_id)
  index (run_id, entity, status)

import_mappings
  id uuid pk, brand_id, run_id fk on delete cascade
  kind import_mapping_kind not null    -- status | priority | group | agent | field | tag | channel
  external_value varchar(300) not null
  target jsonb not null                -- e.g. { statusId } | { departmentId, teamId? } | { userId } | { create: 'invited' } | { fieldKey } | { create: { type, label } } | { skip: true }
  unique (run_id, kind, external_value)

import_external_ids                    -- permanent; makes every run idempotent and deltas possible
  brand_id, source import_source, entity import_entity, external_id varchar(200),
  helpdock_id uuid not null, source_url text null, source_number varchar(50) null,
  payload_hash char(64) not null, imported_at timestamptz
  primary key (brand_id, source, entity, external_id)
  index (brand_id, entity, helpdock_id)

import_log
  id bigserial, brand_id, run_id fk on delete cascade, at timestamptz,
  level import_log_level (info | warning | error), entity import_entity null,
  external_id varchar(200) null, message text not null
```

Columns on existing tables: `tickets.imported_at timestamptz null`,
`tickets.import_source import_source null`; `attachments.origin attachment_origin`;
`ticket_messages.author_display varchar(200) null` (the thread shows it instead
of a staff name when `author_type = 'system'` and it is set);
`csat_answer_channel` + `import`.

`import_file_presets` (M11-15): `id`, `brand_id`, `name varchar(80)`,
`entity import_entity`, `header_fingerprint char(64)`, `mapping jsonb`,
`created_by`, `created_at`; unique `(brand_id, lower(name))`.

**Queue**: `import` added to `packages/jobs/src/queues.ts`, concurrency 1 per
worker for `import.load` (one brand's import never races itself; different
brands proceed in parallel through the BullMQ group or a per-brand Redis lock
`import:lock:<brandId>`).

**Retention**: `import_records`, `import_mappings` and `import_log` rows are
deleted 30 days after a run finishes (`maintenance.retention`, a fixed window
in `data-retention.md`); `import_runs` and `import_external_ids` stay (the delta
and the "Imported from" chip need them).

### M11-07 implementation notes (in progress)

Migration `0054_imports` adds six brand-scoped tables, composite run/brand foreign
keys, terminal credential checks and SHA-256 constraints. It adds imported-ticket
provenance, historical author display names, attachment origin and imported CSAT.
Existing system uploads are backfilled to `channel`. The six tables are in the
RLS registry and negative-suite fixtures. See ADR 0027 amendments. Migration and
isolation checks passed: 61 focused cases on real PostgreSQL plus fresh migration
and terminal-credential/composite-key constraints. Registry/policy unit tests pass.
A parent/delta purge regression also passes: the parent key cascades so the
existing batched brand purge cannot be blocked by its dependent delta rows.
The full negative suite, queue integration and PR CI remain pending.

### M11-08 implementation notes (in progress)

The shared discriminated record uses `{ entity, payload }`; source IDs and original
ISO times remain intact. Field enums retain vendor status/priority/channel strings
for explicit mapping. Attachment references require exactly one HTTP(S) URL or a
relative path under `attachments/`; bundle paths reject traversal. Article locales
are EN/AR. The manifest is versioned and declares per-entity counts. Seventeen
focused schema tests pass. The streaming ZIP reader now validates manifest/counts, attachment references,
member safety and bounded NDJSON (with original UTF-8/line diagnostics). Resource
limits are recorded in ADR 0027 and the workspace README. Twenty-five SDK/file
unit tests pass, including local HTTP, directory compatibility and nesting-depth
regressions. Reference vendor fixtures, attachment delivery and file-mapper
integration remain pending; this deliverable is not complete.

## M11-08 Normalised records and the bundle format

`packages/schemas/src/import.ts`. Every connector and the file mapper produce
these; the loader consumes only these. Times are ISO 8601 with offset; ids are
the source's ids as strings.

```ts
importUserSchema        { externalId, kind: 'agent'|'customer'|'unknown', name, email?, phone?, role?: string, active: boolean, groups?: string[] }
importOrganizationSchema{ externalId, name, domains: string[], notes?, custom: Record<string, unknown> }
importContactSchema     { externalId, name, emails: string[], phones: string[], organizationExternalId?, locale?, timezone?, externalRef?, custom }
importGroupSchema       { externalId, name }
importFieldSchema       { externalId, target: 'ticket'|'contact'|'organization', key, label, type: 'text'|'textarea'|'number'|'date'|'checkbox'|'select'|'multiselect', options?: {value,label}[] }
importTicketSchema      { externalId, number?: string, subject, status: string, priority?: string, channel?: string,
                          requesterExternalId?, assigneeExternalId?, groupExternalId?, organizationExternalId?,
                          ccEmails: string[], tags: string[], custom: Record<string, unknown>,
                          createdAt, updatedAt, solvedAt?, closedAt?, sourceUrl? }
importMessageSchema     { externalId, ticketExternalId, authorExternalId?, authorKind: 'agent'|'customer'|'system',
                          public: boolean, bodyHtml?, bodyText?, createdAt, via?: string,
                          email?: { messageId?, from?, to?: string[], cc?: string[] }, attachments: importAttachmentRefSchema[] }
importAttachmentRefSchema { externalId, fileName, contentType?, size?, url?: string, bundlePath?: string }
importCsatSchema        { externalId, ticketExternalId, rating: 1|2|3|4|5, comment?, ratedAt }
importCategorySchema / importSectionSchema { externalId, parentExternalId?, names: { en?, ar? }, descriptions?: { en?, ar? } }
importArticleSchema     { externalId, sectionExternalId, locale: 'en'|'ar', title, bodyHtml, description?, draft: boolean, internal: boolean, createdAt, updatedAt, translationOf? }
```

Normalisation rules (helpers in `packages/importers/src/normalise.ts`): vendor
ratings to 1–5 (`good`→5, `bad`→1; 3-point scales → 1/3/5); vendor status strings
kept raw (mapping decides); HTML bodies kept as HTML (sanitised by the loader
with the message sanitiser), plain-text bodies wrapped in `<p>` with line breaks.

**The Helpdock import bundle** (documented in `docs/guides/importing.md`): a zip
with `manifest.json` `{ format: 'helpdock-import', version: 1, source: string, exportedAt, counts }`,
one `<entity>.ndjson` per entity (one normalised record per line), and
`attachments/<path>` referenced by `bundlePath`. Max 2 GB, streamed (no full
extraction to memory); validated record by record with line numbers in errors.

## M11-09 The loader

`apps/api/src/imports/loader/` — `import-writer.ts` (all SQL), `load-ticket.ts`,
`load-contacts.ts`, `load-help-center.ts`, `load-csat.ts`, `rebuild-reports.ts`.

**Order** within a run: organisations → contacts (and identities) → users/agents
(per mapping) → fields and tags (create as mapped) → help-center categories,
sections, articles → tickets (each with its messages, attachments refs, tags,
participants, CSAT) → reports rebuild.

**One ticket = one transaction** (`withSystemJob(db, brandId, jobId, …)`), so a
crash loses at most one ticket and a resume repeats it safely:

1. Skip if `import_external_ids (brand, source, 'ticket', externalId)` exists with
   the same `payload_hash` (delta: if the hash differs, update the ticket's
   status/priority/tags/assignee/custom and **append** messages whose external ids
   are new; never rewrite existing messages).
2. `INSERT tickets` with a new number from `nextTicketNumber` (or the vendor number
   per the open question), `prefix`, mapped `status_id`, `priority`,
   `department_id`/`team_id` (group mapping), `assignee_id` (agent mapping),
   `contact_id`, mapped `channel` (default `email` when the source says email,
   else `manual`), `custom` (field mapping; unmapped fields dropped with a log
   line), `created_at`, `updated_at`, `status_changed_at = coalesce(closedAt, solvedAt, updatedAt)`,
   `closed_at` (when the mapped status is closed-state), `imported_at = now()`,
   `import_source`. No `sla_policy_id`, no clocks.
3. `INSERT ticket_messages` in `createdAt` order, `seq` 1..n assigned in memory
   (not `nextMessageSeq`, the ticket is new and locked by the transaction),
   `kind` `public`/`note`, `author_type`/`author_id` from mappings (customer →
   contact id; agent → user id, or `system` with `author_display` when "name
   only"), `body_html` sanitised with `sanitizeMessageHtml`, `body_text` derived,
   `channel` = ticket channel, `external_message_id` = the email Message-ID when
   the source has one (so later email replies thread), `created_at` original.
4. `INSERT ticket_activity` one row `action 'ticket.imported'`, `actor_type 'system'`,
   `via 'system'`, `to: { source, externalId, number, url }`.
5. Tags (create missing as mapped), participants (CC emails as contacts),
   CSAT (`csat_responses` with a random expired `token_hash`, source/external-ID
   provenance, original `closed_at` when supplied or null when unknown,
   `rated_via 'import'`, `sent_at = rated_at`).
6. Attachment refs become `attachments` rows `status 'pending'`, `origin 'import'`,
   `uploader_type 'system'`, with the fetch deferred to `import.attachments`
   (M11-10), which uploads and then writes outbox `attachment.uploaded` (the
   only outbox event of the ticket path; processing, not outbound).
7. `INSERT import_external_ids` for the ticket and each message.

**What is never called**: `TicketsService.create/addMessage`, `TicketLifecycleHooks`
(SLA, CSAT), `ReplyDeliveryHook`, `enqueueOutbox` for any `ticket.*`, `contact.*`
or `email.*` event, `requestAutoAssign`, `enqueueContactCreated`. A unit test
asserts the writer module imports none of them (a dependency-cruiser style check
in `scripts/check-import-writer.ts`, wired into `pnpm check:routes`'s job), and
the integration test asserts the outbox and the side-effect tables afterwards.

**Downstream guards** (small changes in other modules, each with a test):

- Scheduled rules (`rules/time-based`): `time_in_status` is measured from
  `greatest(status_changed_at, imported_at)`, so imported open tickets do not
  fire "open more than 2 days" the minute they land.
- Transcription (`transcription-events.ts`): skip `attachments.origin = 'import'`
  (no AI cost for history).
- Retention: the dry run counts how many imported closed tickets the brand's
  current window would purge that night and shows it as a blocking warning.

**Contacts**: an imported email/phone that already belongs to a contact in the
brand attaches to that contact (logged); otherwise a new contact with
`identities` `source 'import'` (unverified). `insertContact` gets an
`emitCreated: false` option used only by the writer (so no `contact.created`
webhook). Organisations match existing accounts by domain, else are created.

**Help center**: categories/sections/articles via the repositories (not the
service, to avoid per-article events); slugs through `resolveSlug`; article images
fetched (`safeFetch`) into `hc_media` and `img src` rewritten to
`hcMediaPath(brandId, mediaId)` before `sanitizeArticleHtml`; published versions
written with `published_*` and `published_at` = source `updatedAt`. One outbox
event `help_center.imported { brandId, articleIds }` at the end, handled by the
search reindex and knowledge re-chunk subscribers and **not** by webhooks.

**Reports**: after the last ticket, `rebuild-reports.ts` calls
`RollupRepository.rebuild` over `[min(createdAt), max(closedAt))` in 31-day chunks
(capped at 400 days unless the run's option `rebuildAllReports` is set).

**Tests**: unit for each mapper; integration with the 500-ticket reference bundle
(`packages/importers/fixtures/reference/`): counts, threads in order, authors,
dates, notes vs public, tags, CSAT, idempotent re-run, delta append, outbox
contains only allowed events, no rows in `workflow_runs`, `ticket_sla_clocks`,
`notifications`, `ai_calls`, `webhook_deliveries` for imported tickets; scheduled
rule does not fire; transcription skipped; reports show original days.

### M11-09 implementation notes (in progress)

The first writer path loads a ticket and its thread in one caller-owned system
transaction, validates brand/department/status/team/assignee/contact mappings,
keeps source dates and author identities, sanitizes message HTML and stores the
existing canonical email-card metadata. Original agent names can be retained as
system authors. A failed later message rolls back the ticket and earlier messages.

Stable canonical hashes make a repeated load write nothing. A delta updates the
mapped ticket fields and appends unseen messages; existing messages are never
rewritten. Ephemeral attachment download URLs do not change message hashes. A
shared source asset has one original identity/key with copied message references,
and filenames pass `safeFileName`. Shared asset locks are acquired in sorted
order to avoid deadlocks between ticket transactions.

Five focused real-Postgres/Redis integration cases pass for historical dates,
authors/notes, sanitization, no side-effect rows, repeated/delta loads, rollback,
cross-brand mapping refusal and shared attachment identity. Focused unit tests
cover canonical hashes and the existing email-view compatibility. The writer
build check rejects live hooks, outbound helpers and unreviewed dependencies;
it is wired into `pnpm check:routes` and has eight refusal/allowance tests.

This is an implementation checkpoint, not a complete loader. Help-center loading,
report rebuilds, scheduled-rule guards and imported-media completion remain to be
implemented and verified. Shared imported attachment copies must receive their
original's final processed state. The 500-ticket reference import and external
stand-in zero-send assertions are still required before exit criteria are ticked.

### Profile loading checkpoint (M11-09, in progress)

Companies match within their brand by primary or retained source domains;
conflicting multiple matches block loading. Contacts reuse normalized email/phone
owners, add unverified identifiers without downgrading existing verification,
and refuse ambiguous matches. Existing local names/custom data remain unchanged.
A repeat produces no profile/identifier/log writes. Existing merge chains are
followed without rewriting the stable source pointer, preserving undo semantics.

Migration `0055_import_source_details` adds bounded private imported details to
accounts/contacts for company notes/additional domains and raw unsupported phone,
locale/timezone values. Normal account/contact response mappers still whitelist
fields. Contact erasure clears this metadata and matching staged customer data,
including merged ancestors. Raw profile values are excluded from import warnings.

Historical assignments to invited staff retain their eligible brand/department
role without activating the person or sending mail. A reproduced existing bug
made erasure return HTTP 500 for multiple emails of one kind; supporting
[#213](https://github.com/Docker-Hunterpedia/Helpdock/issues/213) now has a passing
real-API regression. Existing channel-trace erasure placeholders retain their
original contract. See ADR 0027 amendments. This checkpoint does not complete
the loader, connectors, jobs or milestone exit criteria.

Verification for this checkpoint: 12 focused real Postgres/Redis writer cases,
five real-API erasure cases, and 44 focused profile/merge/view/erasure unit tests
pass. The API and root fixture typechecks and writer boundary checks pass. Full
reference/vendor/browser/coverage acceptance remains pending.


### Tags, CCs and historical satisfaction checkpoint (M11-09, in progress)

Tickets require an explicit mapping or skip for every source tag, with unique
mapping keys. Brand ownership is checked before tagging; source tag changes
replace the selection without recreating tags that remain. CC addresses are
normalized and deduplicated, reuse their brand's identities without changing
verification, exclude the requester, and create unverified import contacts when
needed. Deltas add new CCs and retain existing participants.

Migration `0056_imported_csat` separates historical ratings from live surveys
using source/external-ID provenance. It preserves original rating times, permits
an unknown historical close to remain null, and enforces complete import
provenance in SQL. Distinct historical ratings do not consume the one-live-survey
per-close key. Imported rows have random token hashes and expired links, and
live survey lookups exclude them. A delta updates a known source rating rather
than adding another answer. Duplicate source rating IDs and cross-ticket ratings
are refused before loading. See the ADR 0027 historical CSAT amendment.

Fifteen focused writer cases pass against real PostgreSQL and Redis, including
repeat/delta behavior, cross-brand tag refusal, historical ratings and live
survey coexistence. Thirty focused contract/CSAT/widget unit tests pass. The
remaining loader paths, privacy handling across complete source bundles, report
rebuild jobs, vendor stand-ins and browser acceptance are still required.


### Historical report checkpoint (M11-09, in progress)

The rollup previously omitted imported public agent replies represented by a
name-only system author. A failing real-Postgres regression reproduced the empty
first-response sample. `REPORT_ROLLUP_VERSION` is now 3: its fallback timing
query counts those replies only on imported tickets with an author display.
Anonymous system messages remain excluded, and the loader refuses to map a
system message to a name-only agent. Agent workload still requires a real staff
ID; it does not synthesize accounts from historical names. The regression also
checks original creation, resolution and rating days and zero SLA outcomes.
The finish job still needs to request the full historical rebuild range.


### Staff and custom-value checkpoint (M11-09, in progress)

Agent mappings explicitly choose an existing brand member, a new invited Agent
with confirmed departments, or the original name only. Existing accounts,
manual/SSO roles and department grants are never changed. A new invited account
has no password, install-admin authority, invitation token or queued mail. Its
manual role reflects the administrator's explicit mapping and is protected from
SSO group sync. A colliding global email requires an explicit existing-person
mapping rather than automatically granting that person a brand membership.
Creation writes `import.staff.created` to the brand's audit log. A repeat in a
new run preserves the source identity and writes nothing. Deactivated targets,
Viewers and foreign departments are refused. The existing Staff resend flow can
issue an invitation later without requiring a pre-existing Redis token.

Mapped custom values use the existing `customValuesSchema` built from that
brand's target definitions. Number/date/text coercions match ordinary writes;
undefined optional fields and cleared values are removed before persistence.
Unknown keys, other-brand definitions and invalid select choices are rejected.
New rows must satisfy required fields; linked contact/company profiles retain
their existing custom data. Repeat hashes retain the unmodified source/mapping
input so coercion does not cause repeated updates.

This checkpoint adds real-Postgres/Redis cases for silent invitation creation,
manual-role preservation, historical staff authors, repeated runs, explicit
existing/name mappings, email collisions, invalid department/activation targets,
custom-value coercion and rollback, and required company fields. Twenty-two focused writer integration cases and five staff contract unit cases
pass, along with API/root typechecks and the writer dependency check.
Field-definition creation, help-center loading,
worker/runtime guards and complete vendor/browser acceptance remain pending.


### Field-definition checkpoint (M11-09, in progress)

Field mappings explicitly reuse a definition, create one from the operator's
confirmed configuration, or skip it. Organization fields target account
custom values. The source field vocabulary remains intact; confirmed definitions
use the ordinary custom-field request schema, including key/label/option limits.
Creation is bounded by `MAX_CUSTOM_FIELDS_PER_TARGET`, locks the target's field
ordering and writes an `import.field.created` audit entry. A colliding key requires
explicit reuse; foreign-brand and wrong-target definitions are refused.

Existing definitions, including local labels, visibility and choices, are never
rewritten by source updates. Repeats across runs preserve the source identity and
write nothing. Changed source definitions refresh the identity hash while retaining
the brand's definition; mapped values still pass the target's value validation.
Twenty-four focused writer integration cases pass on real PostgreSQL/Redis.
The full loader, workers, vendor connectors and UI acceptance remain incomplete.


## M11-10 Import jobs

`packages/jobs/src/jobs.ts`: `import.extract`, `import.load`, `import.attachments`,
`import.finish`, all on queue `import`, payload `{ brandId, runId }`, job id
`import.<step>.<runId>.<attempt-epoch>`; `apps/api/src/imports/jobs/*.job.ts`.
The status machine lives on `import_runs` (claimed with `claimed_at`, a stale
claim older than 30 min is taken over, as `knowledge.sync` does).

- **extract**: for each entity in scope, `connector.extract(entity, cursor)` yields
  normalised records in pages; each page is upserted into `import_records` and the
  cursor saved in the same transaction (resume from the cursor). Rate limits:
  the connector throws `RateLimited(retryAfterMs)` and the job re-enqueues itself
  delayed by that time without counting an attempt.
- **map**: after extract, the run goes `awaiting_mapping` with proposed mappings
  (`connector.defaultMappings(staged)` + name matching against existing statuses,
  departments, staff by email, fields by key). The admin confirms in the wizard.
- **dry run**: validates every staged record against the mappings without writing
  domain rows; fills `dry_run_report` `{ counts, warnings[], blocking[], samples[3 tickets rendered as they would appear] }`.
- **load**: batches of 50 tickets (one transaction each), honouring pause/cancel
  between batches; progress in `counts`.
- **attachments**: pending `origin='import'` attachments of the run, 4 at a time,
  `connector.fetchAttachment(ref)` → stream → `checkUpload` → storage → row →
  outbox `attachment.uploaded`; failures log and leave a placeholder.
- **finish**: reports rebuild, `help_center.imported`, null the credentials,
  `completed`.
- **delta**: a new run with `mode 'delta'` and `parent_run_id`; extract asks the
  connector for records updated since the parent's `started_at` minus 1 h overlap.

**Routes** (`apps/api/src/imports/imports.controller.ts`, `@Controller('api/brands/:brandId/imports')`,
`@Requires('brand:manage')`; creating staff through the agent mapping also checks
`staff:manage`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | runs list |
| POST | `/` | create a draft `{ source, mode, parentRunId? }` |
| GET | `/:runId` | run with counts, status, report |
| PUT | `/:runId/connection` | credentials (write-only) → `connecting`, `connector.test()` |
| PUT | `/:runId/scope` | options |
| POST | `/:runId/extract` | start extract |
| GET/PUT | `/:runId/mappings` | proposed / confirmed mappings |
| POST | `/:runId/dry-run` | run validation |
| POST | `/:runId/start` | start load (refused while a blocking warning stands) |
| POST | `/:runId/pause` · `/resume` · `/cancel` | control |
| GET | `/:runId/log?level=&cursor=` | paged log |
| POST | `/:runId/files` | multipart upload for `source: 'file'` (CSV or bundle, streamed to storage) |
| POST | `/:runId/start-sla` | start clocks for its open tickets (open question 1) |

Audit (brand scope): `import.created|started|paused|cancelled|completed|failed`.

### M11-10 claims and extraction checkpoint (in progress)

Migration `0057_import_worker_claims` adds `claim_token` and `paused_from` with
SQL shape checks and a partial unique claim-per-brand index. Claims are exclusive within a brand and independent across
brands. A stale claim older than 30 minutes is invalidated under the brand lock;
a replacement receives a fresh token. Each batch renews/checks its token in the
same transaction as its writes. Pause and cancel invalidate the current token;
resume restores the exact interrupted phase. Cancellation purges credentials
and sets a finish time. Terminal runs cannot resume or cancel again.

The extraction page store validates JSON-only, same-entity pages (at most 1,000
records and 50 MiB serialized), refuses duplicate IDs within a page, completed
entity writes and non-advancing cursors, and stages parent references for ticket
threads/ratings/attachments and knowledge records. Records, unique extracted
counts, heartbeat and per-entity cursor checkpoints commit together. Overlapping
records across pages update their payload without inflating the count. The last
null cursor marks that entity done. A transaction stopped before commit preserves
the previous cursor and writes no records. Raw vendor bodies are not log text.

This checkpoint proves the database mechanics on real PostgreSQL and Redis.
It does not yet provide registered BullMQ handlers or Redis delay scheduling,
mapping proposals/dry runs, load/attachment/finish jobs,
run-control API endpoints, or the worker-kill reference acceptance test.
Those remain required before M11-10 or the milestone is marked complete.


### Extraction orchestration checkpoint (M11-10, in progress)

`runImportExtraction` drives the normalized connector contract outside database
transactions and stages each page inside the fenced system-job transaction.
It checks authority before requesting another page, resumes incomplete entities
from their saved cursor, skips completed entities, and stops at a final null
cursor. A stream ending without that marker or cycling cursors fails closed.
The operator's selected entities must be supported by the connector. First claim
sets `started_at` once; delta extraction requires a completed parent in the same
brand/source and uses its start time minus one hour.

429 waits persist as `counts.retryAt` and do not increment `retryFailures`.
Claims honor the stored deadline across worker restarts. A successful page clears
retry metadata. Consecutive vendor outages defer for five seconds, with three
failures ending the run and purging credentials. Invalid retry deadlines,
credential refusals and malformed output end the run with safe codes. Opaque
adapter exceptions also end the run with `execution-failed`; their message/body
is never stored in the import log. Graceful shutdown releases the claim for retry
without failing or purging a resumable run. Connector warnings use an explicit
code allow-list and remain scoped to the current run and brand.

The normalized-contract fixtures prove pause/resume, rate-limit persistence,
error budgets, delta overlap, terminal cleanup, warning filtering and incomplete
pagination. Forty-four focused real-Postgres/Redis integration cases pass, with
API/root typechecks, lint and the writer boundary check. These fixtures are not
vendor HTTP stand-ins or BullMQ worker-kill acceptance.
Actual queue handlers/delayed-job transitions, mapping proposals, dry run,
load/media/finish orchestration and vendor/reference/browser CI remain required.


### Shared HTTP security implementation notes (in progress)

`safeFetch` now accepts an exact `allowedHosts` policy checked before DNS at each
redirect hop, preserving its other SSRF checks. A local HTTP regression first
proved that an unrestricted public redirect could leave the intended vendor host;
the policy now refuses it. All 209 net tests pass. Connectors must supply their
verified API/download hosts; SDK and vendor tests remain pending.

## M11-11 Connector SDK and stand-ins

New workspace `packages/importers` (`@helpdock/importers`), depending on
`@helpdock/schemas` and `@helpdock/net` only (the app-boundary rule holds).

```ts
export interface Connector<Credentials> {
  readonly source: ImportSource;
  readonly credentialsSchema: z.ZodType<Credentials>;
  readonly entities: readonly ImportEntity[];            // what this source can export
  test(ctx: ConnectorContext<Credentials>): Promise<{ ok: true; account: string } | { ok: false; reason: ConnectorRefusal }>;
  extract(ctx, entity: ImportEntity, cursor: Cursor | null, since?: Date): AsyncIterable<{ records: ImportRecord[]; cursor: Cursor | null }>;
  fetchAttachment(ctx, ref: ImportAttachmentRef): Promise<{ stream: Readable; contentType?: string; size?: number }>;
  defaultMappings(sample: StagedSample): ProposedMappings;
}
```

`ConnectorContext` carries the decrypted credentials, an `http` client (safeFetch
with `policies.importer`: the vendor's host allow-list, 30 s total, 50 MB for
attachments, redirects re-validated), a `rateLimiter` (token bucket per run, and
`Retry-After` → `RateLimited`), a logger that writes `import_log`, and an abort
signal.

**Stand-ins** (`packages/importers/src/<vendor>/testing/fake-<vendor>.ts`, exported
from `@helpdock/importers/testing`, never bundled into the runtime): HTTP servers
like `FakeGraph`, seeded from the reference dataset in each vendor's own JSON shape,
with controls for 429, 5xx, expired attachment URLs and a "changed since" delta.

### M11-11 implementation notes (in progress)

`@helpdock/importers` contains the typed connector contract, a non-blocking token
bucket, safe status-code errors, `Retry-After` parsing and bounded host-restricted
HTTP with output validation. The runtime exports no testing stand-ins. Unit tests
cover local HTTP success/schema refusal, 429 delay and sanitized vendor errors.
Vendor stand-ins, documented default mappings and extraction adapters remain
pending; this deliverable is not complete.

## M11-12 Zendesk connector

*First task: confirm everything below against developer.zendesk.com and fix this
section.*

- **Auth**: API token (`{email}/token:{token}` basic) or OAuth access token;
  credentials `{ subdomain, email, apiToken } | { subdomain, accessToken }`. Hosts:
  `{subdomain}.zendesk.com` only.
- **Tickets**: incremental cursor export
  `GET /api/v2/incremental/tickets/cursor.json?start_time=<unix>&exclude_deleted=true`
  (start_time ≥ 1 min ago for the first call; follow `after_cursor` until
  `end_of_stream`). Rate limit about 10 requests/min (30 with High Volume) —
  *verify*. Includes archived tickets.
- **Comments**: `GET /api/v2/tickets/{id}/comments.json` (cursor pagination,
  `page[size]=100`): `public`, `author_id`, `html_body`, `created_at`, `via`,
  `attachments[]` (`content_url`, `file_name`, `content_type`, `size`). Archived
  tickets' comments are still served — *verify*.
- **Users**: `GET /api/v2/incremental/users/cursor.json`; `role` end-user → customer,
  agent/admin → agent. **Organisations**: `GET /api/v2/incremental/organizations.json`.
  **Groups** `GET /api/v2/groups`, **ticket fields** `GET /api/v2/ticket_fields`,
  **user/organization fields** likewise.
- **CSAT**: `GET /api/v2/satisfaction_ratings` (`good`/`bad` → 5/1, with comment).
- **Help Center**: `/api/v2/help_center/categories`, `/sections`, `/articles`
  with `/translations` for `en-us`/`ar` locales; draft and permission group →
  `internal`.
- **Default mappings**: status `new`/`open` → Open, `pending` → Awaiting customer,
  `hold` → Open + tag `on-hold` (or a custom status if the brand has one named
  "On hold"), `solved` and `closed` → Closed; priority `low|normal|high|urgent` →
  low/medium/high/urgent; `via.channel` `email|web|api|chat|…` → email/form/api/chat/manual.
- **Attachments**: `content_url` fetched with the same auth when "Secure downloads"
  is on.
- **Delta**: `start_time` = parent run start − 1 h.

## M11-13 Freshdesk connector

*First task: confirm against developers.freshdesk.com/api and fix this section.*

- **Auth**: API key as basic-auth user, `X` as password; credentials
  `{ domain, apiKey }`; host `{domain}.freshdesk.com`.
- **Tickets**: `GET /api/v2/tickets?updated_since=<iso>&order_by=updated_at&order_type=asc&per_page=100&page=n&include=description,requester,stats`.
  Without `updated_since` only 30 days are listed; the list caps the page number
  (reported around 300 pages — *verify*), so extract windows by `updated_since`:
  when a window reaches the cap, start a new window at the last `updated_at`.
- **Conversations**: `GET /api/v2/tickets/{id}/conversations` (`private`, `incoming`,
  `body`, `user_id`, `created_at`, `attachments[].attachment_url`); the ticket's own
  `description` is message 1.
- **Contacts**, **companies**, **agents**, **groups**, **ticket_fields**,
  `GET /api/v2/surveys/satisfaction_ratings`, Solutions
  (`/api/v2/solutions/categories`, `/folders`, `/articles`).
- **Default mappings**: status 2 Open, 3 Pending → Awaiting customer, 4 Resolved and
  5 Closed → Closed; custom statuses from `ticket_fields` mapped by name; priority
  1–4 → low/medium/high/urgent; `source` 1 email, 2 portal → form, 3 phone → manual,
  7 chat, 9 feedback widget → form, 10 outbound email → email.
- **Rate limits**: per-plan per-minute, read `X-RateLimit-Remaining` and
  `Retry-After`.

## M11-14 Zoho Desk connector

*First task: confirm against desk.zoho.com/DeskAPIDocument and fix this section.*

- **Auth**: OAuth 2.0 per data centre (`accounts.zoho.com|.eu|.in|.com.au|.jp|.ca|.sa`),
  a server-based client the admin creates in the Zoho API console; the wizard runs
  the code flow and stores the refresh token (encrypted, purged on finish). Scopes
  (read only): `Desk.tickets.READ`, `Desk.contacts.READ`, `Desk.basic.READ`,
  `Desk.settings.READ`, `Desk.articles.READ` — *verify*. Header `orgId` on every call.
  Hosts `desk.zoho.<dc>`.
- **Tickets**: `GET /api/v1/tickets?from=<n>&limit=100&sortBy=modifiedTime` (offset
  paging; modified-time windows for delta).
- **Threads**: `GET /api/v1/tickets/{id}/threads`, then
  `GET /api/v1/tickets/{id}/threads/{threadId}` for full `content` and
  `attachments[].href`; private comments `GET /api/v1/tickets/{id}/comments`.
- **Contacts**, **accounts**, **agents**, **departments** (→ Helpdock departments),
  Knowledge Base `GET /api/v1/articles` with categories.
- **Default mappings**: `statusType` Open/On Hold/Closed → Open/Awaiting customer/Closed;
  priority names; `channel` Email/Web/Phone/Chat/Twitter/Facebook → email/form/manual/chat/manual/manual.
- **Rate limits**: credit-based per day per plan — *verify*; the connector reads
  remaining credits where exposed and slows down at 10 %.

## M11-15 The manual mapper

Artboard: `Admin/Import-FileMapper`.

- **Upload**: one or more CSV files (UTF-8 or UTF-16, BOM-tolerant, `,` `;` `\t`
  detected) or a bundle zip; streamed to storage under
  `brands/{brandId}/imports/{runId}/files/…`; max 2 GB per file.
- **Entity per file**: the admin says what each file holds (tickets, messages,
  contacts, organisations, articles); a messages file links by a ticket id column;
  a tickets file may carry the first message in a body column.
- **Column mapping**: detected header → target field, with transforms: date format
  (auto-detect ISO, `DD/MM/YYYY`, `MM/DD/YYYY`, epoch, with timezone), split/join
  name, value map (e.g. `Solved` → Closed), boolean, list split by `;`, HTML vs
  plain text, attachment URL list.
- **Preview** 20 rows rendered as normalised records with per-cell errors; nothing
  is staged until the mapping validates.
- **Presets**: saved per brand in `import_file_presets` (M11-07) by name and
  header fingerprint; re-applied automatically when headers match.
- The CSV parser is `csv-parse` (7.x, streaming) and the zip reader `yauzl`
  (3.x, streaming, no full extraction); both added by ADR 0027 and the stack table.

## M11-16 Admin: Brand › Import

Artboards: `Admin/Import`, `Admin/Import-Wizard`, `Admin/Import-Run`.

Route `ROUTES.brandImport` (`/admin/brand/import`) and `/admin/brand/import/:runId`;
nav under Brand for `brand:manage`. Client `apps/admin/src/imports/`
(`api.ts`, `http-api.ts`, `mock-api.ts` with a scripted run that walks every
status, `context.tsx`).

Wizard steps (StepProgress, DESIGN §6.2): **Source** (connector cards + Manual
file) → **Connect** (credential form per connector from its schema; Test shows
the account name; Zoho runs the OAuth popup) → **Scope** (date range, entities,
help center, keep numbers when allowed, rebuild all reports) → **Extract**
(progress, can leave the page) → **Map** (tables per mapping kind with proposed
values highlighted; agents: existing person / create invited / name only) →
**Dry run** (counts, warnings, blocking issues with fix links, three sample
tickets rendered as they will appear) → **Import** (progress per entity, live
log, pause, cancel) → **Done** (summary, warnings, "Start SLA clocks for N open
tickets", "Run a delta sync", link to the imported view).

**Tests**: Playwright (`apps/admin/e2e/import.spec.ts`, `en`/`ar`, axe) through
every step on the mock api including failure states (bad credentials, blocking
retention warning, a failed run with its log); real api
(`apps/admin/e2e/api/import.api.spec.ts`) importing 50 tickets from the Zendesk
stand-in and opening one.

## M11-17 Imported tickets in the workspace

Artboard: `Admin/Ticket-Imported`. The ticket header chip (from `import_source` +
`import_external_ids.source_number/source_url`, added to `ticketSchema` as
`imported: { source, number, url } | null`), the activity line, a "Source:
Imported" filter in views (`imported: boolean` in the view filter schema), and the
System page card "Imports" (running runs per brand, last error).

## M11-18 Import docs

`docs/guides/importing.md`: what is and is not imported (the gap table), each
connector's setup (where to find the token, scopes, data centre), the manual
mapper and the bundle format with an example, the dry-run report, rate-limit
expectations, delta sync, and **the cutover runbook**: freeze or forward the old
tool's email to the Helpdock mailbox, run the full import days ahead, run a delta
on cutover day, switch DNS/forwarding, run a final delta, then disable the old
tool. Updates: `data-retention.md` (import tables, the warning), `reports.md`
(rebuild), `tickets.md` (the chip, `imported_at`), `contacts.md` (import source),
PRD status board.

## Interfaces for other milestones

| Kind | Name |
|---|---|
| Outbox events | `help_center.imported` |
| Jobs | `import.extract`, `import.load`, `import.attachments`, `import.finish`, `sso.metadata_refresh` |
| Queue | `import` |
| Settings | `sso.enforced`, `sso.breakGlassUserIds`, `sso.spPrivateKey`, `sso.spCertificate` |
| Permissions | none new: `install:admin` (SSO), `brand:manage` + `staff:manage` (import) |
| Routes | `/api/install/sso/*`, `/api/auth/sso/*`, `/api/brands/:brandId/imports/*` |
| Packages | `@helpdock/importers`, `@helpdock/importers/testing` |
| Columns | `user_brand_roles.source`, `tickets.imported_at`, `tickets.import_source`, `attachments.origin`, `ticket_messages.author_display` |

## Pull requests

- [#212](https://github.com/Docker-Hunterpedia/Helpdock/pull/212) — M11-04–06 staff SSO integration, bilingual administration and setup guides (merged; all PR checks passed).

- [#207](https://github.com/Docker-Hunterpedia/Helpdock/pull/207) — M11-01 SSO configuration foundation (merged).

- [#209](https://github.com/Docker-Hunterpedia/Helpdock/pull/209) — dependency-aware CI selection (merged).

- [#210](https://github.com/Docker-Hunterpedia/Helpdock/pull/210) — M11-02 OIDC protocol and verified identity handoff (merged).

- [#211](https://github.com/Docker-Hunterpedia/Helpdock/pull/211) — M11-03 SAML protocol, browser handoff and metadata rotation (merged).

## Supporting CI work

[#208](https://github.com/Docker-Hunterpedia/Helpdock/issues/208), implemented in
[PR #209](https://github.com/Docker-Hunterpedia/Helpdock/pull/209), tracks the
owner-requested dependency-aware CI selection supporting M11 and M0-11. PRs
run affected workspace suites and their transitive dependents; global or
incomplete diffs run everything. Main pushes retain the full regression run.
Coverage gates and the required `ci` aggregate remain in place. See the
[development guide](../guides/development.md#the-ci-workflow).
