/**
 * One page per feature that ships in a release. Each section is backed by the
 * guides the page links to; "Not yet" lists only what the guides say is missing.
 */

export type Feature = {
  slug: string;
  icon: string;
  name: string;
  card: string;
  title: string;
  description: string;
  lead: string;
  sections: { heading: string; points: string[] }[];
  limits: string[];
  guides: { label: string; href: string }[];
  channels: string[];
};

export const FEATURES: Feature[] = [
  {
    slug: 'multi-brand',
    icon: 'building',
    name: 'Multi-brand and tenant isolation',
    card: 'Every brand in one install, kept apart by Postgres itself.',
    title: 'Multi-brand help desk with row-level security · Helpdock',
    description:
      'Run many brands from one Helpdock install, each with its own channels, help center domain, widget and AI knowledge, separated by forced Postgres row-level security.',
    lead: 'One install serves many brands. Each has its own face and its own data, and Postgres, not only application code, keeps them apart.',
    sections: [
      {
        heading: 'What each brand gets',
        points: [
          'Its own inboxes and channels, connected under Settings by the brand’s Admin.',
          'A help center on its own verified domain, with a certificate Caddy issues on demand, or under the install’s address.',
          'Its widget theme: accent, surface tone, radius, logo and launcher.',
          'Its AI knowledge, provider choice and daily and monthly budgets.',
          'Its own ticket number prefix and sequence, business hours, time zone and holidays.',
          'Departments and teams. Every brand starts with one department, General.',
        ],
      },
      {
        heading: 'How the data is kept apart',
        points: [
          'Every tenant table carries a brand id under a forced row-level security policy; ticket tables also check the department.',
          'The api runs queries as a database role that cannot bypass row-level security, and refuses to start if its connection could.',
          'A request with no tenant context sees no rows, never every row.',
          'Another department’s ticket answers 404, never 403, so no answer tells “not found” from “not yours”.',
          'Every route declares the permission it needs, and CI fails on a route that does not.',
          'An integration test against real Postgres proves that one brand cannot read, write or delete another’s rows, for every tenant table.',
        ],
      },
      {
        heading: 'People across brands',
        points: [
          'A person has one role per brand: Admin of one brand and Agent of another is normal.',
          'Four roles: Admin, Team Leader, Agent and Viewer. An Agent with no departments sees no tickets.',
          'Contacts belong to a brand, never to a department; the timeline says how many tickets are hidden from the viewer.',
          'Being an install admin is a flag, not a role, and gives no access to any brand’s tickets.',
        ],
      },
    ],
    limits: [
      'A role added in a new brand reaches the person’s session within ten minutes, at its next refresh.',
      'Notification preferences are per person and the same in every brand.',
      'A per-widget department comes with several widgets per brand, which is planned, not built.',
    ],
    guides: [
      { label: 'Security', href: '/docs/security/#tenancy-and-row-level-security' },
      { label: 'Staff and roles', href: '/docs/staff-and-roles/' },
      { label: 'Ticketing settings', href: '/docs/ticketing-settings/' },
    ],
    channels: ['email', 'live-chat', 'web-form'],
  },
  {
    slug: 'slas-and-business-hours',
    icon: 'clock',
    name: 'SLAs and business hours',
    card: 'Clocks on your hours, with escalation before and after a breach.',
    title: 'SLA policies and business hours for support teams · Helpdock',
    description:
      'SLA policies by department and priority, business hours with holidays and time zones, paused statuses, escalation steps and CSAT, in a self-hosted help desk.',
    lead: 'First-response and resolution targets per priority, counted on each brand’s business hours, with escalation steps that act before and after a breach.',
    sections: [
      {
        heading: 'Business hours',
        points: [
          'A brand time zone and seven days, Sunday first, each with up to four time ranges.',
          'Holidays as whole days, for every department or for one.',
          'Department overrides with their own zone and week; brand holidays still apply.',
          'Daylight saving handled by the time zone database.',
        ],
      },
      {
        heading: 'Policies and clocks',
        points: [
          'Policies are tried top to bottom and the first match applies, by department and priority.',
          'Business-hours or calendar (24/7) time, with first-response and resolution targets per priority.',
          'Statuses can pause the clocks; Awaiting customer does out of the box. On resume, only the remaining time is due.',
          'A change of priority, department or policy retargets the clocks and keeps the time already counted.',
          'A reopened ticket starts a next-response clock and a fresh resolution clock.',
          'An AI answer counts as the first response by default; acknowledgments and internal notes never do.',
        ],
      },
      {
        heading: 'Escalation',
        points: [
          'Up to ten steps per policy at a percentage of the target, including after the breach.',
          'Notify Team Leaders, a team or a person; reassign; raise the priority; add a tag; set Escalated.',
          'SLA warnings in the bell; breaches by bell, email and browser push.',
          'Timers are rebuilt from the database on worker start and every hour, so losing Redis loses no deadline.',
        ],
      },
      {
        heading: 'Satisfaction',
        points: [
          'A survey when a ticket is closed: by email, as a card in the widget or as Telegram buttons.',
          'Five scores and an optional comment, through a signed single-use link that expires after 30 days.',
          'A workflow rule can act on “CSAT received”.',
        ],
      },
    ],
    limits: [
      'No report yet of time spent waiting on the customer.',
      'The escalation picker does not check that the people chosen can reach the policy’s departments.',
      'No satisfaction survey on WhatsApp, Messenger or Instagram.',
      'Saving hours or policies recomputes every open ticket, which is slow for a brand with tens of thousands open.',
    ],
    guides: [
      { label: 'SLAs', href: '/docs/slas/' },
      { label: 'Tickets: satisfaction surveys', href: '/docs/tickets/' },
      { label: 'Snooze', href: '/docs/snooze/' },
    ],
    channels: ['email', 'telegram', 'live-chat'],
  },
  {
    slug: 'automation-and-macros',
    icon: 'workflow',
    name: 'Automation and macros',
    card: 'Rules with a test run, macros with placeholders, views and bulk edits.',
    title: 'Help desk automation rules, macros and views · Helpdock',
    description:
      'Workflow and time-based rules with a test run and execution log, routing you can test, macros in English and Arabic, saved views, snooze, bulk edit and shortcuts.',
    lead: 'Rules that act when something happens or when a ticket has waited too long, macros that reply and act in one step, and an inbox you can work from the keyboard.',
    sections: [
      {
        heading: 'Rules',
        points: [
          'When an event happens (created, replied, assigned, SLA warning or breach, CSAT received and more), if conditions match, then act.',
          'Time-based rules run every 15 or 30 minutes, hourly, every 6 hours or daily, at most 200 tickets per rule per tick.',
          'Actions set status, priority or fields, assign (including round-robin), tag, reply, add a note, notify, escalate, close, snooze or ask AI triage.',
          'A test run shows what each condition found and what each action would do, and changes, sends and logs nothing.',
          'An execution log of applied, skipped, stopped and failed runs, filterable by rule or ticket.',
          'A depth guard stops loops: a rule already in the chain, or a fourth rule, does not run.',
        ],
      },
      {
        heading: 'Routing you can see',
        points: [
          'The Routing tab explains the four steps a new ticket goes through: arrival, rules, AI triage and assignment.',
          'Test routing walks a sample message through them and shows the department, rules, SLA due time and who the rotation would pick, without writing anything.',
          'Assignment: manual, round-robin or skill-based, with a load cap and agents marked away when idle.',
        ],
      },
      {
        heading: 'Macros and views',
        points: [
          'Canned responses with placeholders for the contact, ticket, brand, agent and department, in English and Arabic.',
          'Macros add actions: status, priority, tags, assignment or snooze, staged as chips you can remove before sending.',
          'Saved views, personal or shared with the brand or departments; a view never widens what someone can see.',
          'Merge (undoable within 24 hours) and split, and a collision indicator showing who is viewing or replying.',
        ],
      },
      {
        heading: 'Working the inbox',
        points: [
          'Snooze a ticket until a time you pick; it wakes on that time, a customer reply or an SLA step.',
          'Bulk edit up to 50 tickets with a preview of what cannot change, all or nothing, with Undo.',
          'A command palette on ⌘K or Ctrl+K that finds tickets, contacts, articles, pages and actions.',
          'Keyboard shortcuts for moving, replying and triage, which also work on an Arabic layout and can be turned off.',
        ],
      },
    ],
    limits: [
      'Rules are brand-wide, so a Team Leader limited to some departments cannot edit them.',
      'When nobody is eligible in the rotation, the ticket stays unassigned and nothing retries it later.',
      'Bulk edit cannot reply, add notes, merge, split or delete, and is not in the public API.',
    ],
    guides: [
      { label: 'Automation', href: '/docs/automation/' },
      { label: 'Macros', href: '/docs/macros/' },
      { label: 'Snooze', href: '/docs/snooze/' },
      { label: 'Keyboard shortcuts', href: '/docs/keyboard-shortcuts/' },
    ],
    channels: ['email', 'telegram', 'whatsapp'],
  },
  {
    slug: 'help-center',
    icon: 'book-open',
    name: 'Help center',
    card: 'Articles on each brand’s domain, in English and Arabic.',
    title: 'A bilingual help center on your own domain · Helpdock',
    description:
      'A help center per brand on its own domain, in English and Arabic: categories, sections and articles, search that forgives typos, feedback, insights and SEO.',
    lead: 'Each brand publishes its articles on its own domain, in English and Arabic, as fast plain-HTML pages that search engines can read.',
    sections: [
      {
        heading: 'Publishing',
        points: [
          'Categories, sections and articles, with a version per language, drafts and scheduled publishing.',
          'An editor with headings, images (re-encoded to WebP), YouTube and Vimeo, tables, code, callouts, and Markdown import and export.',
          'Public or internal articles, or an internal-only help center; staff read internal ones through a short-lived pass.',
          'The AI can draft an article from a closed ticket for someone to approve.',
        ],
      },
      {
        heading: 'Reading',
        points: [
          'Rendered by the api as plain HTML with no script, on the brand’s verified domain or under the install’s address.',
          'Arabic pages laid out right to left; a missing translation is shown in the default language with a notice.',
          'Search in English and Arabic, forgiving typos in titles and matching the last word as a prefix.',
          '“Was this helpful?” with “What was missing?” on a no.',
          'The widget’s help center mode and suggested articles read the same content.',
        ],
      },
      {
        heading: 'Search engines and insight',
        points: [
          'Canonical links, hreflang, Open Graph and JSON-LD on every page, and a sitemap that never lists internal articles.',
          'Top searches, searches with no results (with Write article) and articles by views and helpful share, over 7, 30 or 90 days.',
          'Theme accent, radius, logo, featured articles, header and footer links, and sanitised custom CSS.',
        ],
      },
    ],
    limits: [
      'Typo tolerance covers titles only, and there is no spelling correction.',
      'Images inside internal articles are not access-gated.',
      'Article versioning with restore and compare is on the backlog.',
      'SVG logos are refused.',
    ],
    guides: [
      { label: 'Help center', href: '/docs/help-center/' },
      { label: 'AI: knowledge', href: '/docs/ai/' },
    ],
    channels: ['live-chat', 'web-form'],
  },
  {
    slug: 'ai',
    icon: 'sparkles',
    name: 'Grounded AI',
    card: 'Answers from your knowledge, or a handoff. Never a guess.',
    title: 'Grounded AI for customer support, self-hosted · Helpdock',
    description:
      'AI that answers customers only from the brand’s knowledge, cites its sources or hands off, assists agents, and runs on the model you choose, including your own.',
    lead: 'The assistant answers customers and helps agents from the brand’s own knowledge base. When that does not answer the question, a person does.',
    sections: [
      {
        heading: 'Knowledge',
        points: [
          'Help center articles, PDF, DOCX, Markdown and text files, crawled websites, Notion and Google Drive.',
          'Answers to visitors read only public knowledge, filtered in SQL before ranking; internal knowledge helps agents only.',
          'Retrieval fuses vector and full-text results, scanning only the brand’s own chunks.',
          'Every chunk passes the prompt-injection filter on the way in.',
        ],
      },
      {
        heading: 'Auto-reply',
        points: [
          'On the widget, email and Telegram, each switched on separately, with its own confidence threshold (0.70 by default).',
          'Every answer cites its sources; a citation that does not resolve to a retrieved document turns the answer into a handoff.',
          'When the knowledge does not answer the exact question, the model says so and the conversation goes to the team.',
          '“Talk to a human” pauses the assistant, and out of hours the widget says when the team is back.',
        ],
      },
      {
        heading: 'Agent assist',
        points: [
          'Suggest a reply with sources marked public or internal, summarise a ticket, translate, and rewrite friendlier, more formal or shorter.',
          'Suggest tags, priority and department from the brand’s own values, or let a rule apply AI triage.',
          'Draft a help center article from a closed ticket, for approval.',
          'Nothing reaches the customer until an agent sends it.',
        ],
      },
      {
        heading: 'Guardrails',
        points: [
          'Text in, text out: the model has no tools and takes no actions.',
          'Email addresses, phone numbers, card numbers and IBANs are redacted before every call, in Western and Arabic digits.',
          'Every call is logged with its model, tokens, cost estimate and latency; daily and monthly budgets cap each brand.',
          'Any provider pi-ai supports (OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral and more) or any OpenAI-compatible server such as Ollama or vLLM.',
        ],
      },
    ],
    limits: [
      'No auto-reply on WhatsApp, Messenger or Instagram.',
      'Assist answers are not streamed, and a budget alert reaches the audit log only.',
      'The published evaluation holds for one provider pair; evaluate the model you choose.',
    ],
    guides: [
      { label: 'AI', href: '/docs/ai/' },
      { label: 'AI: evaluation', href: '/docs/ai/#evaluation' },
    ],
    channels: ['live-chat', 'email', 'telegram'],
  },
  {
    slug: 'sso-and-passkeys',
    icon: 'key-round',
    name: 'SSO, 2FA and passkeys',
    card: 'SAML and OpenID Connect, passkeys and a required second factor.',
    title: 'Staff SSO, two-factor and passkeys · Helpdock',
    description:
      'Staff sign-in over SAML 2.0 and OpenID Connect with walk-throughs for Okta, Entra ID, Google Workspace and Keycloak, plus passkeys, TOTP and breached-password checks.',
    lead: 'Staff sign in with a password and a second factor, a passkey, Google, GitHub or Microsoft, or your identity provider over SAML or OpenID Connect.',
    sections: [
      {
        heading: 'Single sign-on',
        points: [
          'SAML 2.0 with signed assertions, and OpenID Connect with PKCE.',
          'Walk-throughs for Okta, Microsoft Entra ID (OIDC and SAML), Google Workspace (OIDC and SAML) and Keycloak, with presets for Google Workspace and Entra ID.',
          'Accounts created on first sign-in, group-to-role sync, and an “IdP enforces MFA” flag.',
          'Test connection previews the claims without changing anything; enforcing SSO keeps one to three break-glass install admins.',
        ],
      },
      {
        heading: 'Passwords and second factors',
        points: [
          'Argon2id passwords of at least 12 characters, checked against a bundled list of 46,146 breached passwords that is never sent anywhere.',
          'Authenticator apps (TOTP) with single-use recovery codes; a second factor is required for every Admin.',
          'Passkeys as a second factor or as the whole sign-in, up to ten per person.',
          'Sign-in links that only spend themselves when the person clicks Continue, so mail scanners cannot use them.',
        ],
      },
      {
        heading: 'Providers and sessions',
        points: [
          'Google (optionally limited to your Workspace domains), GitHub and Microsoft for one organisation’s work accounts, bound to the provider account rather than its email.',
          'Ten-minute access tokens and rotating refresh tokens; reusing an old one revokes the whole family.',
          'Revoking a session closes its sockets within five seconds.',
          'Every sign-in decision is written to the install’s audit log.',
        ],
      },
    ],
    limits: [
      'No SCIM and no single logout: removing someone at the identity provider does not end their Helpdock session at once.',
      'SSO was verified against stand-in identity providers, not live Okta or Entra ID tenants.',
      'SSO is for staff; customers do not sign in.',
    ],
    guides: [
      { label: 'Authentication', href: '/docs/authentication/' },
      { label: 'SSO', href: '/docs/sso/' },
    ],
    channels: ['api'],
  },
  {
    slug: 'importers',
    icon: 'upload',
    name: 'Importers',
    card: 'Zendesk, Freshdesk and Zoho Desk history, or any CSV.',
    title: 'Import from Zendesk, Freshdesk, Zoho Desk or CSV · Helpdock',
    description:
      'Bring ticket history, contacts, companies and help center articles into Helpdock from Zendesk, Freshdesk, Zoho Desk or CSV files, with mapping, a dry run and deltas.',
    lead: 'A bilingual import wizard brings your history across from Zendesk, Freshdesk and Zoho Desk, and a manual CSV mapper covers every other tool.',
    sections: [
      {
        heading: 'What comes across',
        points: [
          'Tickets with public replies and private notes, authors and original dates; contacts and companies; staff attribution; fields and tags; satisfaction; help center content; and their files.',
          'Files are copied into your own private bucket, so nothing depends on a vendor URL afterwards.',
          'Tickets get new numbers; their original numbers and IDs stay searchable from any view, with an “Imported from” chip.',
          'Contacts are never merged automatically; an existing email attaches to that contact.',
        ],
      },
      {
        heading: 'Connect, map, dry run, approve',
        points: [
          'Map departments, staff, statuses, priorities, channels, tags and custom fields, and save the mapping as a preset.',
          'A dry run with expected counts, ticket and contact previews and file availability, before anything is written.',
          'Watch the approved run, pause and resume it; credentials are encrypted and purged when the run ends.',
          'Deltas from a completed run pick up what changed, reconciled by native IDs.',
        ],
      },
      {
        heading: 'Nothing fires',
        points: [
          'Imported history sends no customer messages and starts no rules, notifications, SLA timers or AI work.',
          'Starting SLA clocks on imported open tickets, and AI embeddings for imported articles, are separate steps you take.',
          'Imported open chats do not join the live widget queue.',
        ],
      },
      {
        heading: 'The CSV mapper',
        points: [
          'UTF-8 or UTF-16 CSV with comma, semicolon or tab, up to 100 files or one bundle ZIP per run.',
          'Tickets, messages, contacts, organisations and articles, with date formats, value maps, splits and joins.',
          'A 20-row preview and a whole-file check before anything is written.',
        ],
      },
    ],
    limits: [
      'Side conversations, macros, automation rules, SLA policies, saved views and channel credentials are not imported.',
      'The importers were verified against stand-in servers built from each vendor’s published API documentation, not against live accounts.',
      'Help Scout, Intercom, Front, Zammad and Gorgias connectors are planned for 1.x and not built; their data goes through the CSV mapper.',
      'Cancelling a run is not a rollback: restore your backup to undo an import.',
    ],
    guides: [{ label: 'Importing', href: '/docs/importing/' }],
    channels: ['email', 'telegram', 'whatsapp'],
  },
  {
    slug: 'api-and-webhooks',
    icon: 'webhook',
    name: 'REST API and webhooks',
    card: 'Scoped keys, an OpenAPI document and signed webhooks.',
    title: 'Help desk REST API and signed webhooks · Helpdock',
    description:
      'A per-brand REST API with scoped keys, an OpenAPI 3.1 document, idempotency and cursor pagination, plus webhooks signed with HMAC-SHA256 and retried for an hour.',
    lead: 'Integrate a CRM, an order system or a script with a brand’s tickets, contacts and articles, and hear back from Helpdock through signed webhooks.',
    sections: [
      {
        heading: 'The API',
        points: [
          'Tickets and their messages, contacts, help center articles and webhook endpoints, under /api/v1.',
          'Keys with scopes, a per-key rate limit (600 a minute by default) and optional expiry; only a hash of the key is stored.',
          'An OpenAPI 3.1 document and reference generated from the same schemas that validate every request.',
          'Idempotency keys kept for 24 hours, and opaque cursors for pagination.',
        ],
      },
      {
        heading: 'Webhooks',
        points: [
          'Ticket created, updated, replied, assigned, status changed, merged and closed; message created; contact created, updated and merged; CSAT received; article published; and account events.',
          'Each delivery signed with HMAC-SHA256 over the timestamp and body, with a stable event id to deduplicate on.',
          'Eight attempts over a little more than an hour; an endpoint that fails ten deliveries in a row is switched off.',
          'A 30-day delivery log with replay.',
          'Endpoints must be HTTPS on a public address, checked when saved and again at delivery.',
        ],
      },
    ],
    limits: [
      'A key reaches one brand and cannot call admin routes.',
      'Bulk changes are not in API v1, and a key cannot file WhatsApp, Messenger or Instagram tickets.',
      'Internal notes are left out of webhooks unless an endpoint asks for them.',
    ],
    guides: [
      { label: 'Public REST API', href: '/docs/api/' },
      { label: 'Webhooks', href: '/docs/webhooks/' },
    ],
    channels: ['api'],
  },
  {
    slug: 'reports',
    icon: 'chart-column',
    name: 'Reports',
    card: 'Volume, response times, SLA compliance, CSAT and workload.',
    title: 'Help desk reports: SLA, response times and CSAT · Helpdock',
    description:
      'Reports on ticket volume, first response and resolution times, SLA compliance, backlog, CSAT, agent workload, help center searches and AI, with CSV export.',
    lead: 'What a brand’s desk is doing, on one screen: volume, speed, SLA compliance, satisfaction and workload, with every figure exportable.',
    sections: [
      {
        heading: 'What is on the screen',
        points: [
          'Tickets created, median first response, SLA met and CSAT, each compared with the previous period in words.',
          'Volume by channel, status or priority; first response and resolution times as median and p90; SLA compliance by priority and clock.',
          'Backlog trend and backlog by status, volume by tag, agent workload and busiest hours.',
          'Help center top searches and searches with no results, AI deflection and AI cost.',
        ],
      },
      {
        heading: 'How it is counted',
        points: [
          'Filter by the last 7, 30 or 90 days or any range up to 366 days, and by department, channel and agent.',
          'Days are the brand’s calendar days in its time zone; times come from the SLA clocks, less the time paused.',
          'Spam, merged and deleted tickets are left out.',
          'Someone limited to some departments gets zeroes for the others, because reports read through row-level security.',
        ],
      },
      {
        heading: 'Export',
        points: [
          'Ten CSV exports in UTF-8, protected against formula injection.',
          'Charts are plain SVG with a table view, mirrored in Arabic.',
        ],
      },
    ],
    limits: [
      'No scheduled email reports and no custom dashboards.',
      'Agent workload goes by today’s assignee.',
      'Backlog by status and the AI cards have no CSV export.',
    ],
    guides: [{ label: 'Reports', href: '/docs/reports/' }],
    channels: ['email', 'live-chat'],
  },
  {
    slug: 'security',
    icon: 'shield-check',
    name: 'Security',
    card: 'Written-down rules, open code and signed images.',
    title: 'Security of a self-hosted help desk · Helpdock',
    description:
      'Row-level security, AES-256-GCM secrets, an SSRF-safe client, careful uploads, an OWASP ASVS Level 2 walk-through and Cosign-signed images with an SBOM.',
    lead: 'The rules are written down, the code is open, and every release image is signed. What follows is what you can check.',
    sections: [
      {
        heading: 'In the application',
        points: [
          'Forced Postgres row-level security by brand on every tenant table, and by department on ticket data.',
          'Secrets (mail passwords, bot and Meta tokens, webhook and AI keys, authenticator secrets) encrypted with AES-256-GCM under a master key kept out of the database, never returned and never logged.',
          'A stored secret is never sent to a destination it was not saved for.',
          'Every fetch of a user-supplied URL goes through one client that blocks loopback, private and cloud-metadata addresses and re-checks every redirect.',
          'Uploads sniffed by magic bytes, images re-encoded, files kept in a private bucket and served through five-minute presigned URLs. SVG and HTML are never allowed; ClamAV is optional.',
        ],
      },
      {
        heading: 'Checked and signed',
        points: [
          'All 258 requirements of OWASP ASVS 4.0.3 Level 2 walked one by one, with the evidence named and no gap open.',
          'Semgrep with custom rules, CodeQL, a dependency audit that fails on high findings, and a ZAP baseline.',
          'Release images for amd64 and arm64, signed keylessly with Cosign and published with a CycloneDX SBOM.',
          'An external pentest of the widget and the API before 1.0.',
        ],
      },
      {
        heading: 'Records and retention',
        points: [
          'An install-wide audit log of who changed what, including every sign-in decision, with secrets shown as redacted.',
          'Retention windows per brand for closed tickets, spam, AI call bodies, search logs and the audit log, purged nightly.',
          'Erasing one person is immediate; a deleted brand has a 30-day grace period.',
          'Vulnerabilities are reported privately, as SECURITY.md describes.',
        ],
      },
    ],
    limits: [
      'The ASVS review is a desk review, and the pentest results are held by the maintainer, not published.',
      'Redis has no password in the production Compose file and must stay unreachable from outside.',
      'Install-scope audit rows, including the sign-in trail, have no retention window yet.',
    ],
    guides: [
      { label: 'Security', href: '/docs/security/' },
      { label: 'Security scanning', href: '/docs/security-scanning/' },
      { label: 'Data retention', href: '/docs/data-retention/' },
      { label: 'Audit log', href: '/docs/audit-log/' },
    ],
    channels: ['api', 'live-chat'],
  },
];

export const feature = (slug: string) => FEATURES.find((item) => item.slug === slug);
