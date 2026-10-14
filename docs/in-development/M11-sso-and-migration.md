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
| M11-08 | Normalised import records and the bundle format: Zod schemas in `packages/schemas/src/import.ts` for users, contacts, organisations, groups, fields, tickets, messages, attachment refs, tags, CSAT, categories, sections, articles, source activity; the Helpdock import bundle (zip of NDJSON + attachments) and its validator | ADR 0027 (2) | Schema tests over fixtures from all three vendors | 2 d | #190 | in progress |
| M11-09 | The loader: `ImportWriter` writes tickets, messages, activity, tags, participants, contacts, identities, accounts, CSAT and help-center rows directly, with no lifecycle hooks and no outbox events except media processing and one `help_center.imported`; idempotent through `import_external_ids`; original dates kept; report rollups rebuilt over the imported range | D §2, §4, §7; ADR 0027 (4–8) | Integration on Testcontainers: a 500-ticket bundle loads; a second load writes nothing; the outbox holds only `import.work_requested`, `attachment.uploaded`, `media.objects.purge` and `help_center.imported`; no email, rule run, SLA clock, notification or webhook delivery exists afterwards; reports count the history on its original days | 5 d | #191 | in progress |
| M11-10 | Import jobs: `import.extract`, `import.load`, `import.attachments`, `import.finish` on the `import` queue; resumable cursors, 429 back-off from `Retry-After`, cancel, pause, progress counters, per-line log, dry run, delta sync, credential purge on finish | A §13; ADR 0027 (9) | Integration: kill the worker mid-load and resume without duplicates; a 429 delays the job by `Retry-After`; cancel stops within one batch; delta brings only changed tickets | 3 d | #192 | in progress |
| M11-11 | Connector SDK and stand-ins: `packages/importers` (new workspace), the `Connector` interface, the rate limiter, `safeFetch` with a vendor host allow-list, attachment fetching, and a stand-in server per vendor for tests | ADR 0027 (10) | The stand-ins' own suites | 2 d | #193 | in progress |
| M11-12 | Zendesk connector: OAuth, with labelled legacy API-token compatibility; incremental tickets, users, organisations; groups, fields, comments, attachments, satisfaction ratings, Help Center; mapping defaults | ADR 0027 (10) | Integration against the Zendesk stand-in: a full extract and a delta; 429 handling; archived ticket comments | 4 d | #194 | in progress |
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
- [ ] After implementation, a separate full import-path review reconciles every
      connector's source fixtures against loaded tickets, contacts, companies and
      knowledge content. Check thread order, authors, dates, notes, attachments,
      fields, tags, assignees, relationships, repeat/delta/resume behaviour and
      absence of sends. The dry-run UI shows representative tickets and contacts,
      data completeness warnings and blocking errors before approval. Record the
      evidence and resolved findings in this document and the final PR.

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
- `0058_imported_knowledge_metadata` (M11-09): private source descriptions for
  help-center categories, sections and article versions, source category parent
  references, and 500-character working/published article titles. Existing tenant
  tables keep their FORCE RLS policies; no new table is introduced.

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
| `Admin/Import-Wizard` dry-run preview states | M11-16 | Sample contacts with identity/company links; sample ticket threads showing notes, authors, original dates and attachment availability; explicit completeness warnings and blocking errors | Owner requested 2026-10-14; extend the existing artboard with DESIGN components before implementation |
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
  source_account_key char(64) not null -- verified account namespace; all-zero reserved for pre-existing unbound data
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
  source_account_key char(64) not null,
  helpdock_id uuid not null, source_url text null, source_number varchar(50) null,
  payload_hash char(64) not null, imported_at timestamptz
  primary key (brand_id, source, source_account_key, entity, external_id)
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
limits are recorded in ADR 0027 and the workspace README. Thirty-two SDK/file
unit tests pass, including local HTTP, directory compatibility, nesting-depth and
malformed-UTF-8 regressions. JSON responses, manifests and NDJSON use fatal UTF-8
decoding so malformed bytes cannot silently alter source history; valid split
characters remain intact. Reference vendor fixtures, attachment delivery and file-mapper
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
                          ccEmails: string[], ccExternalIds?: string[], tags: string[], custom: Record<string, unknown>,
                          createdAt, updatedAt, solvedAt?, closedAt?, sourceUrl? }
importMessageSchema     { externalId, ticketExternalId, authorExternalId?, authorKind: 'agent'|'customer'|'system',
                          public: boolean, bodyHtml?, bodyText?, createdAt, via?: string,
                          email?: { messageId?, from?, to?: string[], cc?: string[] }, attachments: importAttachmentRefSchema[] }
importAttachmentRefSchema { externalId, fileName, contentType?, size?, url?: string, bundlePath?: string }
importCsatSchema        { externalId, ticketExternalId, rating: 1|2|3|4|5, comment?, ratedAt }
importActivitySchema    { externalId, ticketExternalId, authorExternalId?, authorKind: 'agent'|'customer'|'system', action,
                          from?: Record<string, unknown>, to?: Record<string, unknown>, details?: Record<string, unknown>, createdAt }
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
   processing event of the ticket path, not outbound delivery). Source attachment
   removals also enqueue `media.objects.purge` through the reviewed cleanup helper.
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
event `help_center.imported { runId }` at the end when article versions changed,
with the brand in the outbox envelope, handled by the
search reindex and knowledge re-chunk subscribers and **not** by webhooks.

**Reports**: after the last ticket, `rebuild-reports.ts` calls
`RollupRepository.rebuild` from the earliest loaded ticket creation day through
the brand's current local day in inclusive 31-day chunks (capped at 400 days unless
the run's option `rebuildAllReports` is set). The range extends through today because
imported open tickets affect subsequent backlog snapshots; see ADR 0027's report-range amendment.

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
needed. Deltas reconcile source-owned CCs while retaining manually added participants
(see the source-identity CC checkpoint below).

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


### Implementation checkpoint — help-center history (2026-10-14)

The direct writer now loads categories, sections and EN/AR article versions without
calling ordinary publication hooks. Imported translations share one article;
source creation/update times, draft/publication state and internal visibility are
retained. Slugs remain stable on repeat and delta imports. Unchanged source data
does not overwrite local edits. Changed source data updates the mapped content.

Helpdock's category tree is flat. Nested source categories retain their parent
external ID and display a bilingual breadcrumb; cycles and missing parents refuse
loading. Full source category/section descriptions and article descriptions are
retained in private imported metadata, while public descriptions use the existing
300/160-character limits. Article titles now permit 500 characters consistently
in storage and the shared editor/API schema. Oversized bodies or category names
are rejected rather than truncated.

Prepared article images must reference ready, re-encoded media in the same brand.
Remote images, foreign-brand routes and missing media are refused before the body
is sanitized. Media downloading/preparation and final search refresh remain
unimplemented; this checkpoint does not establish full article import acceptance.
The focused writer suite passes 47 cases on real PostgreSQL/Redis. Additional
unit cases cover parser-decoded image sources, storage bounds and complete source
descriptions with safe Unicode display excerpts.

### Implementation checkpoint — imported attachment safety (2026-10-14)

Imported attachment originals now use `attachmentKey(..., 'original')`, matching
the download/variant/purge contract. A repeated source file retains one stored
asset and separate message-authorized rows. Processing settles all same-brand
imported copies together, including kind, size, verdict, variants and processing
time; ordinary upload/channel copies are not changed by that import update.

Imported processing emits no `attachment.ready` event. The transcription
subscriber and worker independently exclude imported files, so stale events and
previously queued jobs cannot send historical audio to AI. The real
PostgreSQL/Redis writer suite passes 49 cases, including a shared PNG converted
to readable WebP, a cross-brand update refusal and absence of outbox/Redis sends.
The media decision suite passes 27 cases, including silent ready/rejected imports.
Three existing live-transcription integration cases still pass, proving ordinary
voice-note scheduling and transcription are preserved.

Supporting issue [#214](https://github.com/Docker-Hunterpedia/Helpdock/issues/214)
fixes an existing split-copy gap: attachment `origin` and message `author_display`
were dropped. The real-API merge/split suite reproduced the channel/import
failures first and passes 25 cases after preserving both fields. This fix belongs
to the owner's single remaining-M11 PR. Import attachment-fetch jobs, orchestration
and connector/browser acceptance remain incomplete.

### Historical source activity checkpoint (M11-08/09/10, in progress)

The original thirteen-entity model could not represent source audit events.
`activity` is now a fourteenth normalized entity, accepted by the bundle/staging
boundaries and the database enum (migration `0059_imported_activity.sql`). It
preserves source event IDs, actor references, action names, before/after values,
details and original dates. The writer stores these as inert
`ticket.imported.event` activity rows; the original action is metadata and is
never dispatched through lifecycle hooks. Shared author resolution retains
name-only staff and checks mapped staff/contact brand membership.

Stable activity IDs participate in the source identity ledger and ticket hash.
Repeated imports write nothing; a changed source event updates its original
activity row without duplicating it or replaying the action. Staged activities
participate in the same fenced ticket transaction, thread-size bound and loaded
counters as messages/ratings/attachments; omitted history is refused. Four
focused real PostgreSQL/Redis cases cover historical dates, authors, inertness,
repeat/delta, invalid authors/parents and staged checkpoints. Boundary unit cases
cover parent association, duplicate event IDs and inert actor/event values. Connector audit conversion,
imported-event presentation and complete end-to-end acceptance remain pending.

### Source-identity CC checkpoint (M11-08/09, in progress)

Tickets can retain `ccExternalIds` when a vendor returns user references instead
of email addresses. Each requires an explicit `resolved.ccContacts` mapping;
missing, duplicate or unexpected mappings are refused. Targets must be active
same-brand contacts, not erased or merged profiles. Identity-only CCs retain a
null address; no email is invented. Participant provenance gains `import` in the
database and public response schema (migration `0060_imported_participant_source.sql`).
Email-derived imported CCs use this provenance too. An available source email can
fill an imported participant's missing address. Delta replaces only source-owned
CC membership; manually added participants and their addresses remain intact.
Creating an email-only contact validates required custom fields rather than
bypassing contact rules. Three real PostgreSQL/Redis cases cover source IDs,
foreign targets, repeat/no-write, email completion, delta/manual preservation and
required-field rollback. This prepares source relationship conversion; vendor
hydration and the wizard's completeness presentation remain unimplemented.

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
  domain rows; fills `dry_run_report` with entity counts, warnings, blocking errors,
  three sample tickets rendered as they would appear and sample contacts with their
  proposed identity/company links. Show public replies and internal notes, authors,
  original dates, attachment availability, tags, fields and assignee mappings in
  the samples. Explain omitted or unsupported source data explicitly. Blocking
  errors prevent starting the import. This contact/history preview requirement
  was added by the owner on 2026-10-14; use the existing wizard artboard and
  DESIGN components, recording any missing state in Artboards to draw.
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
  readonly source: Exclude<ImportSource, 'file'>;
  readonly credentialsSchema: z.ZodType<Credentials>;
  readonly entities: readonly ImportEntity[];            // what this source can export
  test(ctx: ConnectorContext<Credentials>): Promise<{ ok: true; account: string } | { ok: false; reason: 'credentials-refused' | 'vendor-unavailable' | 'invalid-response' }>;
  extract(ctx: ConnectorContext<Credentials>, entity: ImportEntity, cursor: ImportCursor | null, since?: Date): AsyncIterable<ImportPage>;
  fetchAttachment(ctx: ConnectorContext<Credentials>, ref: ImportAttachmentRef): Promise<{ stream: Readable; contentType?: string; size?: number }>;
  defaultMappings(sample: readonly ImportRecord[]): ProposedMapping[];
}
```

`ConnectorContext` carries the decrypted credentials, an `http` client (safeFetch
with the vendor's host allow-list, 30 s total and a hard 50 MiB response cap,
redirects re-validated). The HTTP client owns its token bucket and maps
`Retry-After` to `RateLimited`; the context also carries a run-scoped logger and an abort
signal.

### Durable delta watermark checkpoint (M11-10/11, in progress)

The SDK separates the current run's continuation (`cursor`) from the next delta's
vendor watermark (`deltaCursor`). A final page has `cursor: null` and may retain a
`deltaCursor`, committed with its records/counts. Non-final watermarks and
inconsistent persisted done/cursor states are rejected. Delta extraction reads
the completed same-brand/same-vendor parent's entity watermark; a resumed child
uses its own committed continuation first. The parent's start-minus-one-hour
timestamp remains a reconciliation fallback for connectors without watermarks.
Three focused real PostgreSQL/Redis cases and three boundary cases pass.
Entity bounds now derive from the shared enum, including activity, instead of a
stale hard-coded thirteen. Source-account binding and complete vendor traversal
remain required before this mechanism is exposed through the migration wizard.

**Stand-ins** (`packages/importers/src/<vendor>/testing/fake-<vendor>.ts`, exported
from `@helpdock/importers/testing`, never bundled into the runtime): HTTP servers
like `FakeGraph`, seeded from the reference dataset in each vendor's own JSON shape,
with controls for 429, 5xx, expired attachment URLs and a "changed since" delta.

### Loading checkpoint (M11-09/10, in progress; 2026-10-14)

`loadStagedTicket` owns one fenced transaction checkpoint. It verifies the staged
ticket's brand, run, source and payload hash, compares the complete message/rating
set with the supplied mapped input, and checks standalone attachment references
against their message. Domain rows, child record IDs/statuses and `counts.loaded`
commit together. A rolled-back worker transaction leaves the source records
staged; retrying a committed checkpoint adds no messages or counts. Pause and
claim replacement revoke the old worker before domain writes.

Thread comparisons use maps keyed by source IDs. Child markers update in groups of
1,000 instead of one pair of queries per record. A database-side size check
rejects staged thread payloads exceeding 50 MiB before reading those payloads
into the worker; it measures expanded JSON text, including TOAST-compressed
values. This is a blocking `thread-too-large` error, never a partial thread.
The mapper/dry run must surface this same limit before execution.

Two repeat/delta gaps were reproduced and fixed: deleted or purged ticket
targets were reported as unchanged, and changed source subjects were not applied.
Target availability is now checked under a row lock, including repeat checkpoint
reads. Delta subject updates retain the original creation date. The focused
writer/checkpoint suite passes 58 cases on real PostgreSQL/Redis. This does not
prove worker process termination/restart: the new rollback case simulates loss
before commit. Actual queue wiring, mapping resolution, other entity phases,
attachment jobs, finalization and browser/reference-dataset acceptance remain
incomplete.

Shared `importMappingSchema`/`importMappingsSchema` now validate the seven mapping
kinds, reusing the writer's staff/field targets. Targets reject extra privilege
or secret fields; same-kind source values cannot be mapped twice. An empty group
value represents an explicit destination for source tickets with no group.
Eight focused schema cases and ten existing staff/field contract cases pass.
`saveImportMappings` replaces the list in batches of 1,000 under the same brand
and run locks used by worker controls. Only `awaiting_mapping` and `ready` runs
are editable. Every save clears `dryRunReport` and returns the run to
`awaiting_mapping`; empty lists clear all mappings. Invalid duplicate input,
foreign-brand requests and transaction rollback preserve the previous list and
report. Six focused real PostgreSQL/Redis cases cover these behaviours.
This transaction helper is not yet exposed through the admin API. Permission
checks, semantic target validation, mapping proposals and dry-run generation
remain required before the wizard can use it.
The build guard also scans the import jobs and SDK for live lifecycle hooks,
direct `fetch`, `require` and dynamic module loading; writer dependency checks
remain stricter and forbid direct outbox scheduling in the writer. The reviewed
`enqueueObjectPurge` helper is the sole cleanup exception for removed source files.
Twenty-one guard cases pass. Queue orchestration may use the reviewed outbox path.

### M11-11 implementation notes (in progress)

`@helpdock/importers` contains the typed connector contract, a non-blocking token
bucket, safe status-code errors, `Retry-After` parsing and bounded host-restricted
HTTP with output validation. The runtime exports no testing stand-ins. Unit tests
cover local HTTP success/schema refusal, 429 delay and sanitized vendor errors.
Vendor stand-ins, documented default mappings and extraction adapters remain
pending; this deliverable is not complete.

## M11-12 Zendesk connector

**Official contracts checked 2026-10-14.** Documentation establishes API contracts;
stand-in tests do not prove access or completeness for a real account.

- **Auth/access:** prefer OAuth Bearer. Current [authentication guidance](https://developer.zendesk.com/api-reference/introduction/security-and-auth/)
  deprecates API-token authentication and requires global OAuth for distributed
  integrations, with an internal-use exception. Legacy Basic
  `{email}/token:{apiToken}` is a labelled compatibility mode. Exports require
  an admin; authentication alone is insufficient. Per-ticket audits require
  global OAuth `read`, not `tickets:read` or `auditlogs:read`. Probe each selected
  capability; missing mandatory history blocks extraction.
- **Tickets/users:** `/api/v2/incremental/tickets/cursor.json` and
  `/api/v2/incremental/users/cursor.json`: first Unix `start_time` is older than
  one minute, then follow `after_cursor`/`after_url` until `end_of_stream`.
  Retain the final cursor for delta. Explicitly use `support_type_scope=all`
  for tickets, retaining deletion tombstones. The last minute is excluded;
  archived tickets are included. Organizations use
  `/api/v2/incremental/organizations.json` with `end_time`/`next_page` and stable-ID
  deduplication. [Exports](https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/).
- **Threads:** `/api/v2/tickets/{id}/comments.json?page[size]=100` and per-ticket
  `/audits.json`; traverse every page. Keep `public`, `author_id`, `html_body`,
  original dates and attachments (`id`, `content_url`, `file_name`, `content_type`,
  `size`, `inline`). Description duplicates the first comment, not another message.
  Global audits omit archives; per-ticket audits include them. Archived-comment
  equivalence remains unverified and must appear as a capability gap.
  [Comments](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/),
  [audits](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/).
- **Profiles/definitions:** paginate `/api/v2/groups.json`, `/ticket_fields.json`,
  `/user_fields.json`, `/organization_fields.json`, `/custom_statuses.json`;
  fetch user `/identities.json` for secondary email/phone identities. Keep
  inactive definitions and raw custom values. User role end-user is a customer;
  agent/admin is staff, never permission to grant a target role automatically.
  [Groups](https://developer.zendesk.com/api-reference/ticketing/groups/groups/),
  [ticket fields](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_fields/),
  [user fields](https://developer.zendesk.com/api-reference/ticketing/users/user_fields/),
  [organization fields](https://developer.zendesk.com/api-reference/ticketing/organizations/organization_fields/),
  [custom statuses](https://developer.zendesk.com/api-reference/ticketing/tickets/custom_ticket_statuses/),
  [identities](https://developer.zendesk.com/api-reference/ticketing/users/user_identities/).
- **Default proposals:** status `new/open` suggests open, `pending` awaiting
  customer, `hold` on-hold, `solved/closed` closed; resolve actual brand status
  IDs with confirmation. Custom status categories require their definitions.
  Priority `low/normal/high/urgent` suggests low/medium/high/urgent; null needs
  a visible default. Preserve raw `via.channel`; unknown values require mapping.
  Do not create an on-hold tag as a substitute for state.
- **CSAT:** `/api/v2/satisfaction_ratings.json` is the paginated legacy API. Native scores
  `offered/unoffered/good/bad`: only good/bad are answers. Helpdock conversion
  5/1 is not the source scale. Preserve source dates, comment and native value;
  date filters are rating bounds, not a universal updated-since guarantee.
  [Ratings](https://developer.zendesk.com/api-reference/ticketing/ticket-management/satisfaction_ratings/).
  The current survey API is `GET /api/v2/guide/survey_responses`, with cursor
  pagination and ticket subjects expressed as `zen:ticket:{id}`. CSAT rating
  answers identify `question.sub_type=customer_satisfaction`; other questions
  are not CSAT. Preserve all answer types, native rating/category and answer dates.
  Creation-time filters cannot prove updated-since coverage; rescan for deltas.
  The official list examples contain a duplicated `/api/v2/` in some generated
  snippets; use the declared endpoint and subject-filter example above.
  Checked 2026-10-14: [survey responses](https://developer.zendesk.com/api-reference/ticketing/ticket-management/csat_survey_responses/).
- **Throttle:** generic exports 10/min (30 High Volume), user cursor 20/60.
  Use conservative account/endpoint buckets and runtime rate/remaining/reset
  headers; 429 uses `Retry-After` seconds. [Rate limits](https://developer.zendesk.com/api-reference/introduction/rate-limits/).
- **Guide:** categories, sections, articles and user segments under
  `/api/v2/help_center/`; each article's translations and attachments. Sections
  may nest; enumerate actual locales. Draft is independent from readership:
  `user_segment_id(s)` is the read ACL, `permission_group_id` is editorial.
  Unrepresentable restricted readership defaults to internal with a warning,
  never public. Unsupported locales appear as explicit dry-run omissions.
  [Articles](https://developer.zendesk.com/api-reference/help_center/help-center-api/articles/),
  [translations](https://developer.zendesk.com/api-reference/help_center/help-center-api/translations/),
  [segments](https://developer.zendesk.com/api-reference/help_center/help-center-api/user_segments/),
  [article attachments](https://developer.zendesk.com/api-reference/help_center/help-center-api/article_attachments/).
- **Media:** secure Support URLs can redirect 302 to temporary CDN URLs; expiry
  is unspecified. Refresh from the stable source URL on expiration. Authenticate
  only the verified source origin; every hop uses `safeFetch` and a curated host
  policy. Third-party and Sunshine media auth is not interchangeable with Support
  auth. Log inaccessible, expired or malware-blocked files; never bypass controls.
  [Secure download](https://developer.zendesk.com/documentation/ticketing/managing-tickets/accessing-end-user-uploaded-attachments/),
  [attachments](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket-attachments/),
  [messaging media](https://developer.zendesk.com/documentation/zendesk-web-widget-sdks/messaging_private_attachments/).
- **Deletion/delta:** resume returned cursors/time checkpoints; overlap supplements
  them. Hydrate changed ticket children and reconcile edits/redactions. Deleted
  content has finite retention; redacted content is irrecoverable. Do not infer
  deletion from an absent page or resurrect it. Definitions/Guide need independent
  relists/checkpoints. Child-only redaction coverage and Guide tombstones remain
  unverified; disclose them. [Incremental workflow](https://developer.zendesk.com/documentation/api-basics/working-with-data/using-the-incremental-export-api/).
- **Source identity:** no immutable Support-account ID was established from
  [account settings](https://developer.zendesk.com/api-reference/ticketing/account-configuration/account_settings/).
  A local immutable source binding must distinguish accounts; canonical domain
  changes require explicit rebinding. User/brand IDs are not account identity.

**Stand-in checkpoint (in progress):** `FakeZendesk`, exported only through
`@helpdock/importers/testing`, covers cursor/time exports, paged collections,
comments/audits, Guide translation/read-segment separation, temporary media
redirects, delta, 429 and 5xx. Six local HTTP tests pass through the real safe
client. This first stand-in checkpoint did not include an extraction adapter (see
the subsequent adapter checkpoints below), real-account
proof, archive-comment equivalence, full source audit loading or 500-ticket
acceptance. Those remain required before completing this deliverable.

### Zendesk core extraction checkpoint (in progress)

`ZendeskConnector` now implements ticket/user cursor exports, organization time
exports, group pagination and contact hydration through user identities. Credentials
use a strict OAuth/API-token discriminant and validated subdomain. Pagination
links must match the source origin and endpoint before another authenticated
request is made. Ticket CC user references and custom status category/ID pairs
remain explicit rather than becoming guessed emails or standard statuses.
Known priority/channel values produce mapping proposals; status, group and
other proposals remain required.

Contacts checkpoint individually. A resumed contact page compares its validated
source payload fingerprint before skipping completed profiles; changed pages
fail rather than silently skipping updated data. All identity pages are read.
Native identity kinds and verification methods are retained as private source
metadata; they never verify a Helpdock identity or grant staff permissions.
Contact/company notes, descriptions and known original profile dates are
preserved. New profiles use complete source date pairs; existing local profile
creation dates remain unchanged, and incomplete source dates stay in provenance.

Six local HTTP connector tests and a real PostgreSQL/Redis staging case pass.
The full writer suite passes 75 cases, including private profile metadata and
unverified imported addresses. At the core-only checkpoint, the adapter advertised
those five implemented entities. Subsequent thread/field/tag progress is recorded
below. Audits, CSAT and Guide traversal remain required, along with source-account
binding, completeness reporting, preflight capability checks and full/delta
reference-dataset/browser acceptance. M11-12 is not complete.

### Zendesk comment and attachment extraction checkpoint (in progress)

The adapter now advertises `message` and `attachment` in addition to its five
core entities. It walks ticket export cursors and every comment cursor page,
preserving public/private flags, source authors, original dates, HTML/plain text
and attachment IDs/names/types/sizes/URLs. A source description is not emitted as
a duplicate first reply. Empty plain-text bodies remain valid for attachment-only
comments. Read-only user detail resolves customer/staff authors, with at most
128 cached actor IDs in one extraction. Missing actors currently block extraction
rather than silently assigning their replies to another person.

Each comment commits a continuation containing traversal offsets and page
fingerprints, not bodies, identities or credentials. Resume refuses changed source
pages before skipping previously staged replies. Authenticated comment pagination
must match the source origin, ticket endpoint and returned cursor. Message and
attachment entity checkpoints retain their own final ticket-export watermark.

Eight local HTTP connector cases pass, including a 101-comment paginated thread
and pause/resume with changed-page refusal. The real PostgreSQL/Redis staging case
now verifies two replies and their standalone attachment records. Source audit
conversion, deleted/archive reconciliation, field/tag/CSAT/Guide traversal and
all previous end-to-end acceptance remain required. This checkpoint does not
complete M11-12.

### Zendesk field and historical-tag checkpoint (in progress)

The adapter currently advertises nine entities: ticket, user, organization, group,
contact, message, attachment, field and tag. Field definitions traverse cursor
pages for all three source scopes. Ticket definitions use numeric keys matching
ticket custom values; contact/company definitions retain source keys. External
field IDs include their scope so equal IDs in different collections cannot
overwrite each other. Choice values and labels remain distinct. Known ticket
system fields are handled by ticket mapping rather than duplicated as custom fields.

Text, textarea, integer/decimal, date, checkbox, dropdown/tagger and multiselect
definitions normalize to supported types. Relationship, regular-expression,
currency and other unsupported definitions stop extraction with an import-log
warning; they are not silently converted to text. A mapping-aware preservation
path for these definitions remains required before connector completion.

Historical tags come from ticket exports, with bounded per-page deduplication and
the same terminal delta watermark. The account tag-list endpoint is not a complete
historical source. Official contracts checked on 2026-10-14:
[ticket fields](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_fields/),
[user fields](https://developer.zendesk.com/api-reference/ticketing/users/user_fields/),
[organization fields](https://developer.zendesk.com/api-reference/ticketing/organizations/organization_fields/)
and [tags](https://developer.zendesk.com/api-reference/ticketing/ticket-management/tags/).

Eleven local HTTP connector cases and the focused real PostgreSQL/Redis staging
case pass, covering field pagination/resume, scope collisions, unsupported field
refusal and historical tags. Audits, CSAT, Guide, account binding, complete mapping
and the full acceptance requirements remain unfinished. M11-12 remains in progress.

### Zendesk historical audit checkpoint (in progress)

The adapter now extracts `activity` alongside its previous nine entities. It
reads each ticket's `/api/v2/tickets/{id}/audits.json`, with offset pagination,
per-audit checkpoints, page fingerprints and a final ticket-export watermark for
delta. Archived audit responses can exceed 100 rows; the adapter retains the
whole response within the SDK's HTTP byte limit rather than truncating it.

Change events retain source fields and before/after values, including explicit
nulls. Other historical events, including notifications, retain their native event
payload as inert activity. Audit dates, actor references, source channel and
metadata remain available. Comment/voice-comment audit events are excluded from
activity because replies are extracted separately. Missing/system audit authors
remain system actors; positive user IDs resolve through the read-only user API.
An audit naming another ticket is rejected. No source mutation or notification
send occurs. Contracts checked 2026-10-14:
[ticket audits](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/)
and [audit events](https://developer.zendesk.com/documentation/ticketing/reference-guides/ticket-audit-events-reference/).

Fifteen connector HTTP cases pass, including audit pagination/resume, changed-page
refusal, an unpaginated 101-audit response and changed-history delta. The focused
PostgreSQL/Redis staging test retains the fixture's two non-comment activity rows
and confirms an empty outbox. This is extraction/staging evidence, not full
end-to-end import acceptance. CSAT, Guide, deleted/archive reconciliation, source
binding, mapping-aware unsupported-field preservation and all previously listed
acceptance requirements remain unfinished. M11-12 remains in progress.

### Zendesk satisfaction extraction and provenance checkpoint (in progress)

The adapter now advertises eleven entities, including `csat`. Extraction visits
legacy satisfaction ratings, then current survey responses, with separate
continuations so resume does not restart a completed phase. Both APIs rescan on
delta because their documented creation-time filters cannot guarantee edits to
older answers. Offered/unoffered legacy rows are not answers. Survey responses
without a ticket subject are outside ticket CSAT; multiple ticket subjects or
inconsistent ticket resource names fail rather than guessing ownership.

Legacy good/bad map to 5/1 with the original score, reason, actor IDs and creation/
update dates preserved. Source creation time supplies the reporting timestamp,
with explicit `ratedAtBasis` and an `import.csat.timestamp-inferred` warning;
the API does not expose an explicit submission timestamp. Current surveys use
the CSAT answer's original creation time and map bad/neutral/good categories to
1/3/5. The original numeric rating, category, question definitions, all answer
types and update dates remain in provenance. `import.csat.scale-normalized`
warns that a normalized score is not the original scale.

Normalized CSAT now accepts private `sourceDetails`; migration
`0061_imported_csat_details` retains it in `csat_responses.imported_details` after
staging is purged. Repeat loads leave it unchanged; deltas update it on the same
answer row. Imported answers remain expired and excluded from live survey lookup.
Adapter warnings use approved safe log keys; arbitrary prose cannot bypass the
worker's log boundary. Unsupported field warnings now follow the same contract.

Twenty connector HTTP cases and all 75 writer integration cases pass. Real
PostgreSQL/Redis extraction stages two legacy answers and a current survey answer,
persists both warning keys and leaves the outbox empty. Guide extraction,
deleted/archive reconciliation, source binding, capability preflight, complete
mapping/dry-run UI and full reference-dataset acceptance remain unfinished.
M11-12 remains in progress.

### Zendesk Guide extraction checkpoint (in progress)

The adapter now advertises all fourteen normalized entities. Guide extraction
reads category, section and article collections and each item's paginated
translations. Category/section IDs have explicit prefixes, preserving their
parent references without collisions. Supported English/Arabic translations
retain names/descriptions, article bodies, original translation dates and
individual draft states. The source-locale article is the primary identity;
other supported translations point to it through `translationOf`.

Readership uses `user_segment_id(s)`, not `permission_group_id`. Restricted or
unknown readership imports as internal with a safe
`import.knowledge.readership-restricted` warning. Editorial permission groups
alone do not make public content internal. Each hydrated item checkpoints against
its source collection page fingerprint; resume refuses a changed page before
skipping previously extracted items. Guide deltas currently rescan collections.
Contracts checked 2026-10-14:
[categories](https://developer.zendesk.com/api-reference/help_center/help-center-api/categories/),
[sections](https://developer.zendesk.com/api-reference/help_center/help-center-api/sections/),
[articles](https://developer.zendesk.com/api-reference/help_center/help-center-api/articles/)
and [translations](https://developer.zendesk.com/api-reference/help_center/help-center-api/translations/).

Twenty-four connector HTTP cases pass, including public/restricted/unknown
readership and source-page resume. The focused PostgreSQL/Redis staging test
retains bilingual taxonomy and both article translations, with an empty outbox.
These are extraction/staging checks; image fetch/rewrite and final knowledge
loading are not proven by them.

Nested section support was added in the subsequent ancestry checkpoint below.
Unsupported locales,
multiple variants collapsing to the same en/ar locale, and an unsupported or
missing primary source-locale translation also fail instead of silently dropping
content. These require mapping/completeness handling before connector completion;
they are not added to the accepted-gaps table. Article attachment discovery,
source binding, capability preflight, deleted/archive reconciliation and full
reference-dataset/browser acceptance also remain unfinished. M11-12 remains in progress.

### Nested source section ancestry checkpoint (in progress)

Normalized sections retain the root category in `parentExternalId` and optionally
their immediate source section in `parentSectionExternalId`. Zendesk emits both
references. Migration `0062_imported_section_ancestry` stores the source section
parent on `hc_sections`; the destination remains flat. Nested display names
include bilingual ancestor breadcrumbs, with no invented child translations,
and a transactional `import.section.flattened` warning explains the conversion.

Section ancestry resolves only through scoped imported identities. Cycles,
missing parents and ancestors belonging to another destination category are
refused. The parent payload hash participates in nested child idempotency, so
loading a changed parent before its children updates their breadcrumb. Flat
section hashes remain compatible with the previous loader. The eventual load
runner must order sections by both category and source-section dependencies.

The integration case failed on the previously unsupported parent field before
implementation. All 76 writer cases now pass, including repeat, cycle rollback,
parent-name delta and cross-category refusal, with no outbox sends. Three knowledge
contract unit cases and 25 connector HTTP cases also pass. This resolves the
extraction/direct-loader nesting gap; it does not prove the still-unfinished full
load runner, media preparation, completeness UI or reference-dataset acceptance.

### Shared record-loading checkpoint (in progress)

`loadStagedRecord` now fences field, organization, contact, category, section and
prepared-article writes with the loading claim. It locks and validates the staged
record, verifies source/run/brand and normalized payload hashes, then commits
the domain result, staged status, target pointer and progress together. Explicit
field skips count separately. This complements the existing ticket/thread
checkpoint; it is not yet a complete ordered worker.

Migration `0063_import_record_load_receipts` adds `import_records.load_hash` for
the resolved load request. Completed records refuse a different request on
resume, including changed field mappings. Ticket checkpoints also save and
validate this receipt, refusing changed resolved priorities after commit. A
repeat checks that its source pointer and target still exist; contact pointers
follow manual merges while remaining stable in staging. Article target checks
also require the imported locale version. Counts do not increment on a repeat.

All 79 writer integration cases pass, including simulated transaction loss before
commit, knowledge resume, deleted-target refusal, explicit skip, changed-mapping
refusal and contact-merge resume. The transaction-loss test is not an actual
worker-process-kill acceptance test. Root/API typechecks and structural import
checks pass. Mapping assembly, phase ordering, staff/reference checkpoints,
media preparation, finish/report jobs, dry-run approval and the full worker/API/UI
acceptance remain unfinished. M11-09 and M11-10 remain in progress.

### Custom-field value mapping checkpoint (in progress)

`mappedImportedCustom` translates source field keys into confirmed destination
keys, then applies the existing custom-field coercion, option and required-value
rules. It preserves explicit null clears for patch requests. Only confirmed
skips discard values; unknown keys, duplicate source keys and multiple source
fields targeting one destination key fail rather than silently overwriting data.

`resolveImportedCustom` reads the run's staged field definitions and confirmed
field mappings under the loading scope. It validates staged field hashes, source
identity pointers and same-brand/target destination definitions. Create mappings
must already have a loaded field identity. Contact/company record checkpoints
compare the supplied resolved values to this compiler before writing, refusing
substituted values even when they would fit the destination field's options.

Five compiler unit cases and all 80 writer integration cases pass. The real
PostgreSQL/Redis case maps a native contact key into the brand's existing `tier`
field, rejects a substituted value before load, and leaves the outbox empty.
This does not complete field mapping: proposal generation, option-label/value
mapping, dry-run integration, ticket assembly, ordered phases and the mapping UI
remain required. M11-11 remains in progress.

### Confirmed ticket-routing mapping checkpoint (in progress)

`selectTicketMappings` now resolves exact source status, group, priority, channel,
agent and tag values from confirmed mappings. Missing group/priority/channel
values use an explicitly confirmed empty-key mapping; they do not silently pick
a brand default. Unconfirmed values block loading. Duplicate source tags share
one destination/skip decision, and missing assignees remain unassigned.

`resolveTicketMappings` combines those decisions with loaded staff/contact
identities and the shared custom-field compiler. Requester and CC references
follow source contact pointers through manual merges. Existing staff mappings
must match their loaded source pointer; name-only mappings produce no assignee
account. The normal scoped mapping checks still validate status, department,
team and staff access before any ticket domain writes.

`loadMappedStagedTicket` renews the loading claim and supplies the derived routing
to the atomic ticket/thread checkpoint. Thread, authors and attachment preparation
remain caller responsibilities; this is not the complete assembly worker.

Seven selection unit cases and all 81 writer integration cases pass. The real
PostgreSQL/Redis case refuses a foreign-brand status, then loads confirmed
priority/channel/department, requester and identity-only CC values; a repeat
increments nothing and the outbox remains empty. Author assembly, original
name-only assignee provenance, full staff/reference checkpoints, media fetching,
ordered phases, dry-run integration and the admin UI remain required. M11-10 and
M11-11 remain in progress.

### Staged thread and author assembly checkpoint (in progress)

`loadAssembledStagedTicket` reads the source ticket and every staged child under
the loading claim, using the shared 50 MiB thread-footprint guard before decoding
the children. It validates source hashes, IDs and parent references, gathers
messages/ratings/activity, resolves authors, then invokes confirmed routing and
the atomic ticket checkpoint. Child query ordering is deterministic for stable
resume receipts. No caller-supplied message list is needed.

Customer authors resolve through loaded source contact pointers and manual
merges. Staff authors require confirmed existing/invited/name-only mappings;
name-only authors use validated staged source-user names without creating an
account. Missing references or contradictory customer/staff kinds fail rather
than guessing identity. Assignee references participate in author preparation
so name-only historical assignee display can be retained.

A failing integration test demonstrated that the previous ticket checkpoint
could load failed child rows and mark their history complete. Both assembly and
the direct checkpoint now reject failed/skipped children, invalid hashes and
inconsistent parent references before domain writes. Four author-kind unit cases
and all 83 writer integration cases pass, including complete staged-thread
assembly, private name-only notes, unchanged resume and failed-child refusal.

This is transaction and metadata-loading evidence, not physical attachment-byte
or process-kill acceptance. Referenced-user hydration on deltas, staff/reference
checkpoints, media preparation, ordered phases, finish/report jobs, dry-run and
admin UI integration remain required. Missing staged name-only user data currently
blocks assembly; it is not silently replaced or added to accepted gaps.

### Resumable staff checkpoint (in progress)

The shared record checkpoint now accepts confirmed staff mappings for staged
`user` records. Existing/invited staff commit their source pointer, load receipt,
staged target and progress with the domain work. Name-only staff commit a loaded
history checkpoint with a null account ID; this is not counted as a skipped
person or implemented by creating a dummy user.

Resume validates existing/invited staff through the same membership/status/
department checks as the staff writer, then leaves domain rows and counters
unchanged. Name-only resume validates its immutable load receipt and preserves
the staged source name for thread assembly. Invitation delivery, tokens and
activation remain outside import; invited people stay invited.

All 86 writer integration cases pass, including existing/invited/name-only
checkpoint/resume paths. The cases verify one progress increment, no added user
for existing/name-only choices, one invited user for the invited choice, and an
empty outbox/Redis. This extends the existing silent-staff coverage; it does not
complete reference checkpoints, phase orchestration, delta-author hydration,
physical media preparation or the import UI.

### Prepared record operation assembly checkpoint (in progress)

`loadPreparedStagedRecord` now builds the shared checkpoint's load operation from
the fenced staged row and the run's confirmed mapping rows. Fields/staff use their
confirmed mapping; companies/contacts use the custom-field compiler, and contacts
require a loaded source company when one is referenced. Categories and sections
retain their normalized parent references. Articles require a prepared body
within the existing help-center size limit; there is no raw-body fallback around
media preparation. The contact calling-code input is validated before use.

The integration case stages and loads seven entity types in dependency order,
then repeats every load without incrementing progress again. It verifies the
mapped company value, contact/company relationship, null-account name-only staff
and refusal of an article without prepared content. All 87 writer cases pass with
real PostgreSQL/Redis and an empty outbox in this case.

This resolves manual construction of those record operations. Automated dependency
selection, reference-only rows, prepared media storage, phase/finish orchestration,
source-account binding, dry-run/API/UI integration and full acceptance still remain
required. M11-09 and M11-10 remain in progress.

### Metadata dependency selection checkpoint (in progress)

`loadNextStagedMetadata` selects a ready staged record under the loading claim.
Fields finish before profiles; companies precede their contacts, and knowledge
categories/sections precede their children. Selection filters dependencies before
limiting the query, so an earlier blocked child cannot hide a later ready parent.
A pending parent in the current run takes precedence over an older source pointer.
Cycles or missing dependencies raise `mapping-invalid`; failed staged rows also
block loading. The selector uses the existing prepared-operation checkpoint for
writes and progress.

The PostgreSQL/Redis integration cases stage children before parents, verify
field/company/contact and nested taxonomy load order, and reject a category cycle
without progress. All 89 writer integration cases pass. Reaching `metadata_done`
leaves the run in `loading`: articles, media, tickets, reference rows, finalization,
source-account binding and API/UI acceptance remain required. This checkpoint
does not complete M11-09 or M11-10.

### Missing historical message target regression (M11-09, in progress)

A source message receipt could survive removal of its local message. The writer
previously returned `unchanged` for a repeated ticket, or skipped the missing
message on a changed delta. `requireImportedMessageTargets` now validates and
locks existing message targets before the ticket fingerprint shortcut; the
message-loading path performs the same check. Missing rows raise
`target-unavailable`, and a receipt pointing at a different ticket raises
`duplicate-source-message`. The caller's transaction rolls back domain changes.

The new regression failed with the previous `unchanged` result before the fix.
All 90 PostgreSQL/Redis writer integration cases now pass, including unchanged
repeat and changed-delta refusal, preserved ticket subject and an empty outbox.
Typecheck and the import structural guard pass. Source message edits/redactions,
attachment-byte preparation and the complete delta/reference acceptance remain
unfinished; this fixes missing local message targets only.

### Source message edit checkpoint (M11-09, in progress)

A changed source message previously altered the ticket receipt without updating
the historical body. The regression reproduced the stale private note before the
fix. The loader now sanitizes and updates the same message row and its source
receipt when its payload changes; confirmed author corrections also refresh that
row. Sequence and message identity remain stable, source dates/public-note state
and email metadata remain authoritative, and no reply delivery is invoked.
Rotating download URLs do not count as attachment changes.

Existing imported attachment membership and native metadata are checked before
editing a message. The initial edit checkpoint refused attachment changes with `mapping-invalid`.
The reconciliation checkpoint below supersedes that temporary restriction. The integration case covers edits, sanitization, redaction, corrected
historical names, stable sequence/date, rotating URLs, no duplicate attachment,
unchanged-repeat row revisions and rollback on attachment removal. All 91 writer
integration cases pass with real PostgreSQL/Redis, no outbox or Redis writes.

### Source attachment reconciliation checkpoint (M11-09/10, in progress)

Source message deltas now add/remove imported attachment links in the message
transaction. Existing links are reused; removed links leave ordinary uploads
untouched. Removing the final link queues `media.objects.purge` through the
existing transactional cleanup helper. Shared objects survive while another row
names them, including a historical copy whose original row has been removed.
A changed native filename/type/size receives a fresh pending object instead of
reusing processed bytes. Rotating download URLs remain irrelevant to identity.
A brand/source asset lock serializes reconciliation across ticket transactions.

The structural guard allows only `enqueueObjectPurge` from the media cleanup
module; direct outbox scheduling, other exports, namespace imports and live ticket
hooks remain forbidden. All 21 guard cases and 93 PostgreSQL/Redis writer cases
pass. The integration cases cover final-link cleanup, shared-link retention and
restoration, rollback of links plus cleanup, preservation of ordinary uploads,
changed metadata and repeat no-ops. Cleanup assertions permit only the storage
purge event; no notification or delivery event is created. This is link and queue
evidence: vendor-to-storage downloads, full worker orchestration and end-to-end
reference acceptance remain unfinished.

### Attachment download and processing checkpoint (M11-10, in progress)

`downloadStagedImportAttachment` reads a loaded, hash-validated attachment record
and its same-brand source pointer under the loading claim. It reserves a fresh
object key shared by the asset's pending links, then downloads through the
connector and uploads through `ObjectStorage` outside database transactions.
Only a live claim may commit `processing` and `attachment.uploaded`. A repeat of
an already processing/settled asset returns its actual state without another
vendor request. Policy refusals retain a rejected placeholder and the safe
`import.attachment.rejected` warning; no source URL, credential or vendor body is
included. Other failures propagate for orchestration to retry.

`withPreparedImportFile` writes to an exclusive temporary directory, counts actual
bytes, limits the download to 50 MiB and the largest brand media cap, and bounds
it to 30 seconds or caller cancellation. It checks magic bytes against supported
source MIME claims, otherwise detects a supported family, then applies the brand
policy to the detected kind/type/size. It closes invalid streams and removes
local files on success or failure. No source filename reaches a filesystem path.
This stage does not replace sharp re-encoding or configured antivirus scanning.

Attempt-specific keys prevent revoked workers from overwriting resumed uploads.
Old keys are queued for transactional object cleanup; a stale upload that finishes
after earlier cleanup schedules cleanup again, without deleting keys still named
by attachment rows. Media variants now use the stored object's folder, fixing a
regression where attempt-specific image variants were written somewhere the
normal download path could not find them. The storage double now physically
removes files, rather than only recording deletion calls.

All 97 writer integration cases pass, including actual Zendesk-stand-in PDF/image
downloads through safe HTTP, credential-free CDN redirects, filesystem storage,
WebP processing, repeat no-ops, pause/resume with a late upload, old-attempt cleanup,
and unsafe response rejection without processing events. All 47 focused file/media
unit cases pass, including the failing-before-fix variant-location regression.
These are PostgreSQL/Redis, local HTTP and filesystem-storage results, not a live
vendor or S3 deployment run. Import queue/module wiring, rate-limit orchestration,
bundle bytes, knowledge image preparation, finish/report jobs, API/UI and full
reference/process-kill acceptance remain required. M11-09/10/12 stay in progress.

### Pause checkpoint — 2026-10-14

The owner requested a draft PR now and will resume later. The combined PR's
intended scope remains M11-07 through M11-23; no incomplete deliverable or exit
criterion is marked done. The current work is not ready to merge.

The latest attachment regression reproduced a false rejected-placeholder result
when the target was purged during vendor fetching. Rejection now checks that the
selected target was actually updated before logging or returning a placeholder.
The present-target and purged-target integration cases cover both outcomes.

`jobs/load-batch.ts` is saved as work in progress. It selects metadata, prepared
articles (including primary-before-translation dependencies), and assembled
tickets with separate record transactions and claim checks. It returns explicit
article/reference preparation boundaries and distinguishes domain records loaded
from run completion. At the pause checkpoint it had no dedicated runtime coverage and was not wired
into the queue. The resumed verification below supersedes the coverage limitation;
queue wiring remains unfinished. Resume by adding batch-driver integration tests and completing
reference/media/finish orchestration; do not treat this draft driver as verified.

Remaining work includes immutable source-account binding; referenced user/ticket
hydration for deltas; bundle and knowledge image preparation; queue definitions,
handlers, module wiring and report finalization; mapping proposals and dry run;
CSV mapping/presets; the seven remaining researched vendor connectors/stand-ins;
admin API and EN/AR import screens, imported-ticket UI, guides and cutover docs.
The final full import-path review, 500-ticket datasets, actual process-kill tests,
browser/axe checks and aggregate CI/coverage gates remain required. Real-vendor
and live-deployment validation are also unproven. Local research artifacts under
`reports/` and `research_notes/` are retained outside the committed PR.

### Resumed batch verification and CI inventory fixes (M11-07/09/10, in progress)

The batch driver now has five real PostgreSQL/Redis integration cases. They prove
staff-before-ticket loading across separate bounded batches, primary-before-
translation ordering, pause checks after external article preparation, repeat
no-ops, explicit unresolved-reference boundaries and refusal of orphan history.
Domain-record completion leaves the run `loading` with attachment processing
still pending. All 103 writer integration cases pass. Reference checkpointing,
physical knowledge preparation, queue wiring and finalization remain required.

CI run `38509308134` exposed stale schema/migration/queue inventories and missing
import credential coverage in master-key rotation. The inventories now include
migrations 0059–0063, the six import tables, the bigint import-log key exception
and the fourteenth queue. `import_runs.credentials_encrypted` participates in
rotation; `claim_token` is explicitly classified as an unencrypted worker fencing
nonce. The new real-PostgreSQL rotation case proves a new key alone decrypts the
pending credential, the nonce/status stay unchanged and a repeat rotates nothing.
All 35 focused database unit cases, 18 migration/key-rotation integration cases
and 23 observability integration cases pass. The generated migration metadata was
formatted for CI with unchanged parsed JSON content.

These fixes address the inspected CI failures; aggregate CI and coverage require
a new run and are not claimed green. The original 1.0 and extra-connector scope,
remaining deliverables and exit criteria stay open.

### Reference loading checkpoint (M11-09/10, in progress)

The batch driver now consumes reference-only customer users, groups and tags.
Customer users resolve the source contact pointer and validate the surviving
contact after a manual merge; they never create staff accounts or roles. Groups
resolve confirmed department/team mappings. Tags resolve confirmed tag mappings
by source label; an explicit null target records a skip. Missing mappings,
foreign-brand targets, erased contacts and changed retry selections fail rather
than reporting completed records.

Reference receipts, their selection hashes and progress counters commit in the
same fenced transaction. A committed retry validates the target without adding
counts. Reference rows do not add global user/group/tag pointers: contacts already
carry the customer identity, and confirmed run mappings carry routing/tag targets.
This avoids confusing customer references with staff users or departments with
teams. See ADR 0027's reference-receipt amendment.

The writer integration suite passes 105 cases on real PostgreSQL and Redis,
including customer account isolation, reference retries, explicit tag skips,
foreign department refusal and unresolved/orphan record failures. Domain-record
completion still leaves the run loading; media processing and finalization remain
required. CI found a generated configuration-guide mismatch; the rotation note
now also lives in the `.env.example` comments used by the generator.

### Attachment batch and finalization boundary (M11-10, in progress)

`runImportAttachmentBatch` downloads at most four pending staged attachment
records per invocation, with network/storage work outside transactions and the
existing fenced publication path. Downloads now run with a four-file concurrency bound; production
queue registration remains required. Repeating while media
processing is pending performs no additional vendor fetch. A lost or paused claim
returns stopped and cannot authorize the next phase.

`beginImportFinishing` checks all staged records and source-owned physical media
before atomically moving the live claim from loading to finishing. Pending or
processing files keep the run loading. Missing media fails with target-unavailable;
ready, rejected and infected files are settled outcomes. Rejection remains a
placeholder outcome, not proof that the file was imported successfully. Original
source pointers can resolve a surviving copied attachment after its root link was
removed. The boundary emits no outbox event and does not mark the run completed.
Report rebuilds, the single help-center reindex event, completion audit and terminal
credential purge remain required.

Real PostgreSQL/Redis cases cover every media state, a transaction rollback and
missing-media refusal. Existing fake-Zendesk PDF/image cases now exercise batch
download, wait without refetching, media processing, phase advancement and stale
claim refusal. The rollback writer test now scopes its source-ID assertion to its
own ticket and messages instead of matching unrelated fixture IDs by substring.

### Resumable historical report rebuild (M11-09/10, in progress)

`rebuildImportReportsBatch` rebuilds one inclusive local-day chunk of at most 31
days per fenced finishing transaction. Report rows and `counts.importReports`
advance together; rollback preserves both the previous cursor and previous rows.
The range is derived from same-brand loaded ticket targets, refuses missing or
foreign targets, and extends through the current local day for backlog snapshots.
A run without loaded tickets has no report range. `rebuildAllReports` opts into
history beyond the default 400-day window; clipping adds one safe warning code
`import.reports.history-clipped` when the first chunk commits.

The checkpoint freezes timezone and the SLA reopen metric choice; changing either
mid-backfill is refused rather than mixing report grains. Committed retries
continue at the next local day. Once the report cursor is complete, retrying
performs no report-row rewrite. This step leaves the run finishing and retains
credentials until the final completion transaction.

Four unit cases cover the 400-day policy, empty/recent ranges, month boundaries,
future dates and invalid checkpoints. The real PostgreSQL/Redis writer suite
passes 114 cases, with new isolated-brand report cases proving original creation,
name-only staff response and closure dates, three resumed chunks, rollback,
completed retries, pause/configuration fencing, clipping warnings and foreign
pointer refusal. Registered finish jobs, reindexing, audit and terminal credential
purge remain unfinished.

### Completion transaction and help-center subscribers (M11-09/10, in progress)

`runImportFinishBatch` combines the last report chunk and `completeImportRun` in
one brand transaction. Completion requires settled records/media and a complete
report checkpoint. It writes one `import.completed` audit, nulls credentials and
worker claim fields, sets the finish time and changes status to completed.
Retries return already-completed without another audit or event. Pause/replacement
still revokes worker authority before a nonterminal completion.

Article checkpoints set `counts.knowledgeChanged` only when the writer creates or
updates a version. Completion emits a single `help_center.imported { runId }`
outbox event only for such runs. Unchanged repeat imports emit none. The payload
uses the retained run rather than an unbounded array of article IDs; see ADR 0027.
Default handling validates the payload, page-cache handling invalidates the brand,
and search/knowledge subscribers read distinct same-brand imported article targets
in keyset pages of ten. Deleted targets are skipped through the article join.
Published en/ar versions are indexed and converted to knowledge documents;
draft versions schedule no embeddings. Existing knowledge queue behavior only
schedules embeddings when chunks were written. This event is not registered with
the webhook subscriber.

The writer suite passes 117 real PostgreSQL/Redis cases. New cases prove the
credential/audit/event rollback, terminal retries, no event on unchanged imports,
original report completion, brand isolation, ten-plus-two article pages, en/ar
search/knowledge output and no repeated embedding scheduling. Focused help-center
subscriber unit tests and the strict event-payload schema test cover registration
and input rejection. These primitives are not yet registered as BullMQ import
handlers or exposed through the import API/UI; worker-kill and 500-ticket acceptance
remain required.

### Source-account identity checkpoint (M11-07/09/10, in progress)

Migration `0064_import_source_accounts` adds `source_account_key` to runs and the
external-ID ledger, validates lowercase SHA-256 shape, and extends the ledger's
primary key. Pre-existing rows retain a reserved all-zero namespace; no old data
is guessed to belong to a particular account. The migration adds columns before
replacing the primary key and uses an explicit short constraint name.

`bindImportSourceAccount` hashes the vendor and its verified canonical account
identifier, excluding credentials. Only draft/connecting runs can bind; binding
a different account after staging or during an active phase is refused. A delta
must bind to its completed same-brand/vendor/account parent. The writer derives
the namespace from the run for all identity reads and writes. Attachment upserts,
thread child receipts and SQL dependency selectors use the same key, so native
IDs from another account cannot satisfy a source dependency or overwrite targets.

The real PostgreSQL/Redis writer suite covers distinct tickets, messages, contacts
and attachments for two accounts with identical native IDs, an unchanged repeat,
active/staged binding refusal, mismatched delta parents and a cross-account article
dependency. Two unit cases cover stable account hashing and malformed input;
32 database schema cases and 11 migration cases pass. Connection/API/manual-file
flows still need to invoke binding before extraction/loading. The next checkpoint resolves the identified RFC collision without discarding
original headers. Connection/UI binding and the full milestone acceptance remain
required before account isolation is complete.

### Historical mail identity and threading (M11-07/09, in progress)

The two-account RFC collision was reproduced first: a second native message failed
against `ticket_messages_external_key`. Migration `0065_import_message_identity`
adds a nullable source-account marker, backfills known imported messages and their
same-brand copy chains, and limits live external-ID uniqueness to unmarked rows.
A separate lookup index covers historical reference reads. Original RFC IDs stay
in `external_message_id`; the import ledger remains the native idempotency key.
Old copies with missing headers remain missing; the migration does not guess or
restore potentially erased metadata. New split copies preserve the import marker,
original historical RFC ID and existing email metadata.

Live inbound deduplication ignores historical rows. Thread lookup considers public
email only, prefers Helpdock delivery IDs over live received IDs and historical
IDs, and resolves a historical ID only when it names one ticket. A known ambiguous
reference prevents fallback to a subject ticket number; unknown IDs still allow
normal fallback. Participant checks remain mandatory. Outbound references exclude
private notes. Imported Message-IDs reject empty values, NULs and line breaks,
including a trailing newline.

The writer suite passes 120 real PostgreSQL/Redis cases, including identical RFC
IDs across accounts and retained live uniqueness. Seven focused unit/schema cases
cover header validation and deterministic reference resolution. Three real email
API cases on PostgreSQL/Redis/Mailpit prove live delivery/deduplication, ambiguous
history with a valid subject token, live-reference preference and verified sent
mail winning over conflicting imported history. Twelve migration cases include
an upgrade-shaped backfill of roots/copies and live uniqueness after the change.
The existing 25-case merge/split API suite passes, and three focused provenance
cases additionally prove copied original email metadata. Queue/API/import UI and
the remaining milestone acceptance are still unfinished.

### Typed import jobs and transactional work requests (M11-10, in progress)

The job registry now declares `import.extract`, `import.load`, `import.attachments`
and `import.finish` on queue import, with strict brand/run-only payloads and the
normal bounded retry/retention profile. `enqueueImportWork` writes an
`import.work_requested` outbox row in the caller's phase-change transaction.
Its validated step and optional ISO `notBefore` never carry vendor credentials.

The worker registers a scheduling subscriber and closes its queue with the other
handler resources. The subscriber checks the live phase and active brand, refuses
unbound namespaces or mismatched delta parents, computes the remaining delay and
uses a stable phase/run/outbox job ID. Redelivery is a BullMQ duplicate rather than
another attempt. Paused/cancelled requests are ignored when handled. Extraction's
parent lookup now checks the account key as well as brand/vendor/completed state.

The writer integration suite passes 122 cases. A real Redis/BullMQ case proves
transaction rollback, delayed job creation, stable redelivery, zero initial attempts,
pause handling and foreign-brand refusal. Another case refuses unbound and
cross-account delta scheduling. Job-registry/payload unit tests pass 84 cases; five producer/subscriber boundary
cases reject malformed requests and credential-bearing payloads before I/O. Eight
worker startup cases and API/root typechecks pass.
The import consumer, connection factory and resumable phase scheduling remain to
be wired; no complete worker or process-kill acceptance is claimed yet.

### Queue consumer and phase continuations (M11-10, in progress)

`createImportProcessor` validates queue payloads before I/O, checks current
phase/brand/account eligibility, claims the run and dispatches to extraction,
loading, attachment or finish drivers. Extraction may consume the already-fenced
claim so the consumer does not compete with itself for ownership. Load batches
request more load work or attachments; settled attachments move to finishing;
report chunks request further finish work until terminal cleanup.

`continueImportWork` commits claim release and the next outbox request together.
Rate-limit deferral retains credentials, stores its retry deadline and publishes
a delayed phase request without failing the run. Known loader failures retain
safe codes; opaque exceptions become execution-failed. Terminal consumer failure
purges credentials/ownership and writes one safe import.failed log and audit.
Paused/replaced workers cannot publish continuation or failure checkpoints.

The writer suite passes 125 real PostgreSQL/Redis cases. A real BullMQ worker
consumes staged history across load, attachments and report/finish jobs to
completion, retaining both messages and purging credentials. Focused cases prove
rate-limit claim release/deadlines and credential retention, terminal retries,
safe exception handling and exactly one failure audit. Two consumer boundary
unit cases reject malformed payloads and unrelated job names before I/O.

This consumer accepts a connector resolver and article preparation dependency;
production connector/worker registration was pending at that checkpoint; the subsequent production consumer checkpoint registers Zendesk. Article preparation
is required rather than silently dropping remote images. Recovery after a process
is killed between a domain batch and its continuation request still requires the
recovery scheduler and actual process-kill acceptance test. Expired URL
handling and the complete factory/preparation/API/UI path remain to be completed.

### Recovery scheduling checkpoint (M11-10, in progress)

`import.recover` is registered as a strict empty-payload maintenance job, scheduled
every minute on worker boot. It lists active brands through the existing global
brand helper, then handles tenant runs in their own system transactions. Under the
brand claim/control lock, it selects at most 100 eligible runs: bound account,
active extracting/loading/finishing state, absent/expired ownership, due vendor
retry and no recovery request in the preceding minute. It clears only expired
ownership, records recoveryRequestedAt and enqueues a phase request atomically.
Loading recovery restarts the checkpointed load driver, which leads to attachments
when records are complete. Fresh workers, paused runs and future retry deadlines
are left alone. The internal work-request event is explicitly included in silent
import acceptance and ADR 0027; it has no customer/rule/AI/webhook subscriber.

The writer suite passes 126 real PostgreSQL/Redis cases. An isolated-brand recovery
case proves expired-token fencing, repeat-sweep cooldown, delayed retry exclusion,
paused-run exclusion and that a replacement worker's fresh claim is retained.
This simulates lease expiry; an actual killed-process test remains required.
Additional connector factories, article preparation, complete retry
handling, API/UI and the rest of the milestone remain unfinished.

### Bounded parallel media and vendor retry budget (M11-10, in progress)

The attachment batch now starts at most four pending downloads together and drains
all promises before returning or propagating failure. Successful files retain
processing state when another file fails; the next batch selects only pending
files. No worker authority is released while a started download is still running.

Transient vendor-unavailable errors in queued phases use a three-consecutive-error
budget. The first two failures log safe warnings and request delayed retries;
the third stores the failure count, fails the run and purges credentials through
the existing terminal checkpoint. A 429 logs a safe rate-limit warning and retains
both credentials and the existing outage count. Successful continuation resets
the outage budget. Unrepresentable retry dates fail as invalid-response rather
than leaving a held claim. Extraction retains its existing retry budget path.

The writer suite passes 130 real PostgreSQL/Redis cases. Local Zendesk HTTP/storage
cases prove four concurrent files, full draining after a mixed failure, preserved
successful rows, retry of only the failed file, and no refetch while processing.
Consumer cases prove 503/429 budget handling, terminal credential purge and invalid
retry dates. Expired URL refresh, production registration, knowledge-image/file
orchestration, API/UI and complete acceptance remain unfinished.

### Zendesk attachment refresh contract recheck (M11-12; 2026-10-14)

Official [Attachments API](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket-attachments/)
confirms agent-authenticated `GET /api/v2/attachments/{attachment_id}`, using the
integer ID supplied by comments, returns `attachment.id`, file_name, content_type,
size and content_url. This is the metadata resource for refreshing a stale URL.
The [URL-property guidance](https://developer.zendesk.com/documentation/api-basics/best-practices/working-with-url-properties/)
explicitly permits externally hosted content_url assets and requires avoiding
credential disclosure. The [secure-download guide](https://developer.zendesk.com/documentation/ticketing/managing-tickets/accessing-end-user-uploaded-attachments/)
describes authenticating the account URL and following its temporary redirect.
The newer [Attachment Content API](https://developer.zendesk.com/api-reference/attachments/content/)
describes tokenized content and redirects for expired/used tokens; it does not
promise that every external CDN uses that behavior. A stale external URL may fail
and must be refreshed through the account API, with a bounded retry.

The stand-in now implements the documented Show Attachment response, mandatory
account authentication and missing-resource 404s. Existing secure redirect/CDN
controls remain. The connector now refreshes a failed external download once through authenticated
Show Attachment metadata, validates the returned native ID, and downloads the
fresh content_url without account credentials on external origins. Account-origin
401/403 failures remain credential errors; 429 and vendor failures retain the
normal retry behavior. Only the final response origin is retained in transport
errors, excluding paths, queries and credentials.

A missing or permanently unavailable attachment retains its original-name
placeholder with `object_missing` and one `import.attachment.unavailable` warning.
Repeated processing does not fetch or warn again. PostgreSQL/Redis integration
covers expired URLs through storage and deleted files through placeholders;
connector tests cover bounded retries, ID mismatch and redirect credential
stripping. This checkpoint does not complete M11-10 or M11-12.

### Production consumer registration checkpoint (M11-10/11, in progress)

The worker now registers an import BullMQ consumer at concurrency one and closes
it before media and queue producers during shutdown. The connector runtime reads
one run under its brand/system context, decrypts its AES-GCM credential envelope,
validates credentials and refuses a different bound source account before HTTP.
Zendesk is registered; remaining connector factories are pending alongside those
connectors. Unsupported sources fail explicitly.

The account API hostname is derived from validated credentials; additional
attachment destinations come from `options.downloadHosts` (at most 32 exact
lowercase hosts). SafeFetch checks every redirect against that list and retains
DNS/IP checks. Production restricts destination ports to 443 with the existing operator CIDR
exceptions. A bounded account token bucket retains local budgets across
continuations; process restart resets it. When locally exhausted, the runtime
waits for its ten-token burst to refill at 60 requests/minute, allowing resumed
pages to re-read their parent and child before their next cursor checkpoint.
Connector logging shares the extraction
code allow-list so vendor bodies, URLs and credentials cannot become log text.

Tests cover worker startup/shutdown and real PostgreSQL/Redis runtime account
binding, cross-brand refusal, corrupted encryption, download-host refusal and
attachment bytes. Connection API/UI host approval, article preparation, file
source orchestration and the other vendors remain unfinished. This does not
complete M11-10 or M11-11.

### Staff connection API checkpoint (M11-10/16, in progress)

The API registers ImportsModule and five `brand:manage` routes: list/create/get
runs, PUT connection and POST extract. Shared Zod DTOs define HTTP input and
output/OpenAPI. Read models select only public IDs/state/dates, a credentials-set
boolean and extracted/loaded/skipped counters; credential envelopes, worker
claims, cursors, options and internal errors never appear in those responses.
The newest 100 runs are returned; cursor pagination remains to be added.

The Zendesk connection test uses the same transport construction as the worker.
Only successful verification binds the source account, encrypts credentials and
moves the draft to connecting. Delta parents must be completed, same-brand,
same-source and same verified account; mismatch is a safe conflict response.
Starting extraction commits status, audit and import.work_requested together.
Repeated starts are refused. Failed tests and rolled-back starts leave no partial
credentials or jobs. Zendesk credentials now live in packages/schemas and are
re-exported by the SDK so admin/API/connector boundaries share one contract.

Real PostgreSQL/Redis/vendor-stand-in coverage exercises those transitions, secret
non-disclosure, cross-brand reads, delta mismatch and rollback. Shared schema and
public-view unit tests pass. The subsequent HTTP/control checkpoint covers real staff authentication and permissions; browser flows remain pending.
Date filtering, mapping/dry-run/start/log routes and the UI remain unfinished.
See the current [import guide](../guides/importing.md). M11-10/16 remain in progress.

### Authenticated HTTP, scope and controls checkpoint (M11-10/16, in progress)

Real password/TOTP sessions now exercise all nine registered import routes with
Postgres/Redis and the Zendesk stand-in. Anonymous requests are 401; Agent, Team
Leader and Viewer sessions are 403. A brand Admin cannot use another brand's
routes or read a foreign run through their own brand. The staff resolver reads
Bearer tokens, so cross-origin requests carrying only cookies do not authorize
writes. No development-principal header is used in this suite.

PUT scope accepts unique, nonempty entity lists and rebuildAllReports before
extraction; reconnection preserves those options and run responses include only
that public scope. Pause revokes the worker lease; resume atomically requests the
appropriate existing phase; cancel clears credentials and ownership. Invalid
transitions return conflict. A dry-run resume currently conflicts and rolls back
until its consumer is implemented, rather than releasing a run with no job.
Cancellation stops further processing without deleting already imported history.

Shared scope schemas and HTTP tests cover malformed input, frozen scope,
secret-free responses, lease revocation, resume outbox requests, credential purge
and repeated starts. Date-range filtering, pagination, mapping/dry-run/start/log
routes, dry-run recovery and browser flows remain unfinished. M11-10/16 remain
in progress.

### Mapping confirmation and input snapshot (M11-10/16, in progress)

GET/PUT mappings now return confirmed mappings and an input fingerprint. Both
routes require brand:manage; invited-agent confirmation also checks staff:manage.
The existing replacement engine validates unique kind/source keys, batches writes,
returns ready runs to awaiting_mapping and removes obsolete dry-run reports.
Automatic proposals remain pending; GET currently returns confirmed mappings only.

The fingerprint holds the brand lock and scans metadata in 500-row pages ordered
by existing run/entity/external-ID and run/kind/external-value indexes. It covers
source/account/mode/parent/options and staged IDs, parents, hashes, status and
mapping targets. Retry/lease progress and credentials are excluded. It returns only
a SHA-256 value, never source payloads or secrets. This is an input snapshot;
payload/hash integrity, relationships, live target state and completeness still
need the read-only dry-run validator. No approval/start route is added yet.

Real database coverage changes records and mappings beyond the first page,
verifies stable repeated reads and retry-metadata exclusion, refuses another
brand, and proves unchanged source-row/ticket revisions and no outbox events.
Real-session HTTP coverage checks all eleven registered routes, mapping replacement,
duplicate refusal and obsolete report invalidation. The three-ticket/contact
preview, attachment availability, semantic validation and approval enforcement
remain unfinished. M11-10/16 remain in progress.

### Read-only staged integrity and reference checks (M11-09/10/16, in progress)

Preflight now has pure staged-record validation and source-dependency collection,
plus a read-only database reference checker. Staged IDs, normalized payload hashes,
status and staging parent must agree. Staging and preflight share one SDK parent
function, including section/category and translation/section distinctions. The
assembled-ticket loader uses the same staged integrity check for tickets and children.

Reference checks distinguish staff/customer/system authors; missing non-system
authors fail rather than receiving a guessed person. They check source ticket,
message, contact, organization and knowledge dependencies. Delta fallback uses only
the same brand/vendor/account identity ledger. Self-parent references, corrupted
staged dependencies, attachment/message ticket disagreement and mismatched inline
attachment metadata are blocking structural issues. Shared attachment references
remain valid when metadata agrees. These functions create no domain rows or jobs.

Unit coverage exercises author kinds, missing authors, Arabic translation dependencies,
parent grouping and tampered staged fields. Real Postgres/Redis coverage proves
account isolation, corrupt/mismatched dependencies, self-parent refusal, unchanged
ticket revisions and no outbox events. The full loader integration suite passes
with the shared validation. The dry-run consumer/report, live destination validation,
mixed staged/live hierarchy validation, attachment availability and three-ticket/contact previews remain
unfinished. These checks alone do not approve a run; M11-09/10/16 remain in progress.

### Staged hierarchy cycle preflight (M11-10/16, in progress)

Read-only reference validation now walks staged category parents, section ancestry
and translation chains iteratively. It detects cycles reached through a valid
prefix as well as direct loops, without imposing an arbitrary source depth cutoff.
Missing staged ancestors remain the responsibility of dependency/live-target
validation; mixed staged/live destination hierarchy validation is still pending.

Unit cases cover a prefix entering a cycle, a 2,000-record rooted chain, missing
staged ancestry, section cycles and translation cycles. The real database reference
case verifies that a valid root leading into a multi-record loop is a blocking
reference-cycle issue. No domain rows or jobs are created. The dry-run consumer,
report, destination validation, availability and preview UI remain unfinished;
these checks alone do not approve loading. M11-10/16 remain in progress.

### Read-only live mapping destination checks (M11-10/16, in progress)

Preflight now checks individual confirmed mapping destinations without creating
staff or fields: statuses/tags must exist in the brand; teams must belong to the
selected department; existing staff must have a non-Viewer membership and not be
deactivated. Invited staff require same-brand departments and a validated staged
agent with an email. Field destinations must match their source entity; known
field bindings cannot be redirected, new definitions cannot collide with an
existing key, and a single new field requires available capacity.

Real database coverage verifies missing/foreign destinations, department/team
mismatch, explicit tag skips, Viewer refusal, invited-agent prerequisites, field
entity mismatch, key collision and safe reuse of an existing source field binding.
User and field row revisions remain unchanged and no outbox work is created.
Whole-plan field creation capacity/duplicate checks, ticket-specific staff department
eligibility, custom value validation, contact identity planning and the complete
dry-run consumer/report/UI remain pending. Individual target checks do not approve
a run; M11-10/16 remain in progress.

### Whole field creation/binding plan preflight (M11-10/16, in progress)

Preflight now evaluates field mappings together before provisioning. It rejects
duplicate destination keys across new and reused/existing destinations, collisions
with existing keys, and a set of additions exceeding MAX_CUSTOM_FIELDS_PER_TARGET
for ticket/contact/account independently. Known bindings do not consume new slots;
a deleted/wrong-entity binding or an attempted redirect is blocked.

The database adapter reads only the current brand's definitions and queries needed
source field bindings in 500-ID chunks under the same vendor/account namespace as
loading. It does not allocate IDs, create definitions or modify existing fields.
Pure cases cover duplicates, aggregate capacity, namespace separation and binding
conflicts. Real database coverage uses a nearly full field target, proves another
account's binding cannot free a slot, checks same-account reuse and duplicate
plans, and asserts unchanged field revisions and no outbox events.

Ticket-specific department checks, field/custom value validation, contact planning
and complete dry-run orchestration/report/UI remain unfinished. These plan checks
alone do not approve loading; M11-10/16 remain in progress.

### Ticket routing and invitation preflight (M11-09/10/16, in progress)

Read-only ticket routing now selects the same confirmed status/group/priority/channel,
agent and tag mappings as loading and verifies live selected destinations. Existing
and reused invited assignees must be active/invited non-Viewers eligible for the
selected department. New invitations must include that department. A shared pure
eligibility rule is used in both preflight and the loader.

Individual staff target validation also refuses redirecting a known source binding,
checks all departments of reused invitations, and checks new invitation email
collisions against install-wide case-insensitive user uniqueness without returning
any matching user/brand. It does not create a user or widen a membership.

Unit cases cover eligible active/invited staff, missing/deactivated/Viewer membership
and department scope. Real database coverage checks ticket department mismatch,
missing mappings, new invitation scope, existing-email collision and same-source
invitation reuse; user/ticket revisions remain unchanged and no outbox work is
created. Custom values, contact planning, duplicate planned invitations and the
complete dry-run consumer/report/UI remain unfinished. M11-09/10/16 stay in progress.

### Complete invitation email plan preflight (M11-10/16, in progress)

Preflight now checks proposed new invitations together using the same normalized
email spelling as staff loading. Duplicate new invitation addresses, including
case-only differences, block every affected source agent. Reused same-account
identities create no user and do not reserve a changed source email. Missing or
non-agent invitation data remains invalid even when a binding is reused.

The read-only adapter validates requested source user records in 500-ID batches,
looks up only matching brand/vendor/account bindings and retains just ID/kind/email
metadata for the complete-plan check. Issue results contain source IDs and safe
codes, not email addresses. No invitation token, user, membership, mail or queue
work is created.

Pure tests cover duplicates, reuse and invalid source data. Real Postgres/Redis
coverage splits a duplicate across rows 0 and 500, proves another account's binding
cannot exempt it, verifies same-account reuse and unchanged user revisions, and
asserts no outbox events. Value validation, contact planning and the complete
dry-run consumer/report/preview UI remain unfinished; M11-10/16 stay in progress.

### Read-only custom value projection (M11-10/16, in progress)

Preflight now resolves source fields against confirmed mappings, existing definitions
and proposed new definitions without creating fields or allocating destination IDs.
It reuses mappedImportedCustom, the loader's normal conversion/required/choice rules.
Known field bindings select the real existing definition; redirected/deleted bindings,
wrong entity targets, ambiguous keys and unconfirmed source values are blocked.
Only an explicit skip removes a source value. Patch previews use partial validation.

Real Postgres/Redis coverage projects a required numeric field before creation,
rejects invalid/unknown/missing values, accepts a partial patch and proves unchanged
field revisions and no outbox work. It then creates the field through the loader
and proves identical projected values before/after creation and no preview mutations.
Contact identity planning, media availability and complete dry-run orchestration,
report and preview UI remain unfinished. These projections alone do not approve
loading; M11-10/16 remain in progress.

### Read-only contact identity planning (M11-10/16, in progress)

Preflight now uses the loader's normalized email/phone matching and stable source
merge-pointer resolution to plan create/link/update/unchanged contact outcomes.
The shared matcher retains row locking for loading and offers a read-only path
for preflight. It allocates no contact IDs and does not change profiles, identities
or verification. Conflicting identity candidates block rather than suggesting an
automatic merge. Invalid phone counts are retained for the eventual report.

The plan distinguishes local display name/company from supplied source values,
because import linking preserves local names and company relationships. Exact
repeat input uses the same payload hash as loading and reports unchanged.
Real database coverage verifies create and reuse, ambiguous identity refusal,
unchanged profile/identity revisions, local/source company distinctions, loader
link parity and subsequent unchanged/update outcomes, with no outbox work.

Planning across multiple new source contacts, source organization creation links,
media availability and complete dry-run consumer/report/UI remain pending. These
contact plans alone do not approve loading; M11-10/16 remain in progress.

### Contact identity collisions across the plan (M11-10/16, in progress)

Preflight now compares normalized identifier claims across projected contact
outcomes. Different proposed new contacts sharing an identifier are blocking
contact-plan-ambiguous issues, rather than allowing sequential creation/reuse to
implicitly combine their histories. Overlapping identifier chains mark every
participant once. Source aliases already linking to the same existing local contact
are allowed; unchanged receipts reserve no historical identifiers because loading
adds nothing for those receipts. Issue output contains source IDs and safe codes,
not the conflicting email/phone values.

Pure tests cover new conflicts, shared existing targets, unchanged receipts and
transitive overlaps. Real database coverage proves that two new source people
produce a conflict without creating a contact, then permits both aliases when a
local identity already exists, with unchanged profile revisions and no outbox work.
Planned organization resolution, media checks and complete dry-run consumer/report/
preview UI remain unfinished. These plan checks alone do not approve loading;
M11-10/16 remain in progress.

### Read-only organization identity planning (M11-09/10/16, in progress)

Preflight now shares organization domain normalization and matching with loading,
including imported domain aliases, account-scoped source bindings, ambiguity
refusal and missing prior targets. It plans create/link/update/unchanged outcomes
without allocating company IDs or modifying companies. Local company names remain
separate from the supplied source names. The loader retains its existing advisory
locks and write behavior around the shared read-only matcher.

Unit coverage verifies trimming/case normalization, duplicate removal and empty
value exclusion. Real database coverage proves new-company planning, local domain
and imported-alias reuse, conflicting company refusal, unchanged company revisions,
loader link parity and unchanged/update plans, with no outbox work.

Contact references to newly planned organizations, cross-source organization
collisions, media availability and full dry-run consumer/report/preview UI remain
unfinished. These organization plans alone do not approve loading; M11-09/10/16
remain in progress.

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

- [#215](https://github.com/Docker-Hunterpedia/Helpdock/pull/215) — combined M11-07–23 migration work in progress (draft; work continuing, not ready to merge).

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
