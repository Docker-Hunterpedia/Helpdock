/**
 * The `helpdock` Agent Skill: a SKILL.md that tells an AI agent when to use it
 * and where to look, and the release's guides under references/. Every fact in
 * the body comes from the install, operations, API and webhooks guides; the
 * task map names guides, and building fails if one of them is gone.
 */
import type { Guide } from './bundles.ts';
import type { ZipEntry } from './zip.ts';

export const SKILL_NAME = 'helpdock';

/** What an agent may be asked to do, and the guide that answers it. */
export const TASKS: [task: string, guide: string][] = [
  ['Install Helpdock on a Linux server with Docker Compose', 'install'],
  ['Deploy on Dokploy, Coolify, Render or DigitalOcean', 'deploy'],
  ['Look up an environment variable or install setting', 'configuration'],
  ['Back up, restore, upgrade or rotate the master key', 'operations'],
  ['Prove a backup restores', 'restore-drill'],
  ['Set retention windows or erase a person', 'data-retention'],
  ['Connect a mailbox (IMAP or inbound parse)', 'email'],
  ['Send replies and auto-replies by email', 'outbound-email'],
  ['Connect a Telegram bot', 'telegram'],
  ['Connect WhatsApp, Messenger or Instagram', 'meta-channels'],
  ['Embed the live chat widget or speak its protocol', 'widget-protocol'],
  ['Turn on the hosted web form', 'web-form'],
  ['Work tickets: statuses, views, merge, bulk edit', 'tickets'],
  ['Set up departments, statuses, fields and assignment', 'ticketing-settings'],
  ['Configure SLA policies and business hours', 'slas'],
  ['Write workflow and time-based rules', 'automation'],
  ['Write macros and canned responses', 'macros'],
  ['Publish the help center on a brand domain', 'help-center'],
  ['Configure AI providers, knowledge and auto-reply', 'ai'],
  ['Import from Zendesk, Freshdesk, Zoho Desk or CSV', 'importing'],
  ['Configure staff sign-in, 2FA and passkeys', 'authentication'],
  ['Set up SSO over SAML or OpenID Connect', 'sso'],
  ['Manage staff and roles', 'staff-and-roles'],
  ['Review the security model', 'security'],
  ['Call the REST API', 'api'],
  ['Receive and verify webhooks', 'webhooks'],
  ['Read reports or export CSV', 'reports'],
];

const DESCRIPTION =
  'Use when installing, configuring, operating, upgrading or integrating Helpdock, the open-source self-hosted help desk: the Docker Compose install and its .env, backups, restores and upgrades, channels (email, Telegram, WhatsApp, Messenger, Instagram, the chat widget, the web form), SSO and sign-in, AI and knowledge, importers, and the REST API and webhooks.';

function skillBody(version: string, siteUrl: string): string {
  return `# Helpdock ${version}

Helpdock is an open-source (AGPL-3.0), self-hosted customer support platform:
ticketing, a help center, a live chat widget and AI that answers only from the
brand's knowledge, with one Docker Compose deploy serving many brands, in English
and Arabic. This skill documents release **${version}**; \`references/\` holds the
guides published with it (also at ${siteUrl}/docs/).

## Where to look

| To | Read |
|---|---|
${TASKS.map(([task, guide]) => `| ${task} | [references/${guide}.md](references/${guide}.md) |`).join('\n')}

Read the reference before answering; quote its settings and paths exactly.

## Install (references/install.md)

Needs a Linux server with Docker Engine and the Compose v2 plugin, 2 vCPU and
4 GB of memory, two DNS names (admin app, and API and widget), ports 80 and 443,
and an S3-compatible bucket.

\`\`\`bash
git clone --depth 1 --branch v${version} https://github.com/Docker-Hunterpedia/Helpdock.git
cd Helpdock/docker
cp ../.env.example .env
openssl rand -base64 32   # the master key, for APP_MASTER_KEY
\`\`\`

In \`.env\`, set \`HELPDOCK_VERSION=${version}\` and at least \`APP_URL\`,
\`APP_MASTER_KEY\`, \`HELPDOCK_APP_PASSWORD\`, \`DATABASE_URL\`,
\`POSTGRES_PASSWORD\`, \`DATABASE_MIGRATION_URL\`, \`ADMIN_HOST\`, \`API_HOST\`,
\`ACME_EMAIL\` and the \`S3_*\` keys. Then:

\`\`\`bash
docker compose up -d
docker compose ps
\`\`\`

Open \`https://<ADMIN_HOST>\` and finish the first-run wizard. Back up \`.env\`
with the database: without \`APP_MASTER_KEY\`, no stored secret can be read back.

## Upgrade (references/operations.md, "Upgrading")

Migrations are forward-only and run when the api boots. Read the release notes,
take a database dump, then pin the new release:

\`\`\`bash
cd Helpdock
git fetch --tags && git checkout v${version}
cd docker
sed -i 's/^HELPDOCK_VERSION=.*/HELPDOCK_VERSION=${version}/' .env
docker compose pull
docker compose up -d
docker compose logs -f api
\`\`\`

If a migration fails, the api exits before it listens; restore the dump with
the previous \`HELPDOCK_VERSION\`.

## REST API essentials (references/api.md, references/webhooks.md)

- Per brand, under \`/api/v1\`: tickets and their messages, contacts, help center
  articles and webhook endpoints.
- Create a key in **Developers › API keys**; it is shown once. Send
  \`Authorization: Bearer hd_live_…\`.
- Scopes: \`tickets:read\`, \`tickets:write\`, \`contacts:read\`, \`contacts:write\`,
  \`articles:read\`, \`webhooks:manage\`.
- The reference is at \`<APP_URL>/api/docs\` and the OpenAPI 3.1 document at
  \`<APP_URL>/api/docs/openapi.json\`.
- 600 requests a minute per key by default (\`429\` above it); an
  \`Idempotency-Key\` is kept for 24 hours.
- Webhooks are signed: \`X-Helpdock-Signature: t=<unix>,v1=<hex>\`, the hex
  HMAC-SHA256 of \`timestamp + "." + rawBody\` under the endpoint's secret. Refuse
  timestamps more than five minutes old and deduplicate on the event \`id\`.

## Facts that hold everywhere

- Helpdock is self-hosted only; Docker Compose is the supported runtime.
- Every AI mode is off until a brand's Admin turns it on.
- Each brand's data is kept apart by Postgres row-level security.
`;
}

/** The skill's files, relative to its folder: SKILL.md and references/<guide>.md. */
export function skillFiles(input: {
  version: string;
  siteUrl: string;
  guides: Guide[];
}): ZipEntry[] {
  const ids = new Set(input.guides.map((guide) => guide.id));
  const missing = TASKS.map(([, guide]) => guide).filter((guide) => !ids.has(guide));
  if (missing.length > 0) {
    throw new Error(
      `the helpdock skill names guides that are not published: ${missing.join(', ')}`,
    );
  }
  const frontmatter = `---\nname: ${SKILL_NAME}\ndescription: ${JSON.stringify(`${DESCRIPTION} Documents Helpdock ${input.version}.`)}\n---\n\n`;
  return [
    { path: 'SKILL.md', content: frontmatter + skillBody(input.version, input.siteUrl) },
    ...input.guides.map((guide) => ({
      path: `references/${guide.id}.md`,
      content: guide.markdown,
    })),
  ];
}
