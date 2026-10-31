/**
 * The sidebar of /docs/. Every guide in docs/guides/ is published except the
 * ones listed in UNPUBLISHED; a guide no group names lands under "More guides",
 * so a new guide appears without a change here.
 */

/** website.md is how to maintain this site, not how to run Helpdock. */
export const UNPUBLISHED = new Set(['website']);

/**
 * Meta descriptions for guides whose first paragraph is not a summary (a
 * generated-file notice, a pinned version, a status line). The rest use theirs.
 */
export const DESCRIPTIONS: Record<string, string> = {
  configuration:
    'Every environment variable and install setting Helpdock reads, with its default, what it does and where it can be changed.',
  deploy:
    'Running Helpdock on Dokploy, Coolify, Render, DigitalOcean App Platform or behind an existing reverse proxy, with what each template needs.',
  importing:
    'Importing ticket history, contacts, companies and help center content from Zendesk, Freshdesk, Zoho Desk or CSV files, with a dry run before anything is written.',
  install:
    'Installing Helpdock on your own Linux server with Docker Compose: what you need, DNS, the .env file, the first-run wizard, upgrades and backups.',
  'audit-log':
    'The install-wide audit log: who changed what, the sign-in trail, who may read it and how long rows are kept.',
};

export const DOC_GROUPS: { title: string; guides: string[] }[] = [
  {
    title: 'Run Helpdock',
    guides: [
      'install',
      'deploy',
      'configuration',
      'operations',
      'performance',
      'data-retention',
      'restore-drill',
    ],
  },
  {
    title: 'The desk',
    guides: [
      'tickets',
      'ticketing-settings',
      'slas',
      'automation',
      'macros',
      'snooze',
      'contacts',
      'staff-and-roles',
      'notifications',
      'keyboard-shortcuts',
      'reports',
      'attachments',
    ],
  },
  {
    title: 'Channels',
    guides: [
      'channels',
      'email',
      'outbound-email',
      'telegram',
      'meta-channels',
      'web-form',
      'widget-protocol',
      'realtime',
    ],
  },
  { title: 'Knowledge and AI', guides: ['help-center', 'ai', 'importing'] },
  {
    title: 'Sign-in and security',
    guides: ['authentication', 'sign-in-providers', 'sso', 'security', 'audit-log'],
  },
  { title: 'Developers', guides: ['api', 'api-reference', 'webhooks', 'development'] },
  { title: 'Project', guides: ['release', 'security-scanning', 'screen-reader-pass'] },
];

export type DocLink = { id: string; title: string };

/** Docs pages that are not guides: the API reference, built from the OpenAPI document. */
export const REFERENCE_PAGES: (DocLink & { description: string })[] = [
  {
    id: 'api-reference',
    title: 'REST API reference',
    description:
      'Every /api/v1 endpoint with its scope, parameters, request body and response, and every webhook event’s payload.',
  },
];

export function groupGuides(guides: DocLink[]): { title: string; guides: DocLink[] }[] {
  const byId = new Map([...guides, ...REFERENCE_PAGES].map((guide) => [guide.id, guide]));
  const named = new Set(DOC_GROUPS.flatMap((group) => group.guides));
  const groups = DOC_GROUPS.map((group) => ({
    title: group.title,
    guides: group.guides.flatMap((id) => byId.get(id) ?? []),
  }));
  const rest = guides
    .filter((guide) => !named.has(guide.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (rest.length > 0) groups.push({ title: 'More guides', guides: rest });
  return groups.filter((group) => group.guides.length > 0);
}
