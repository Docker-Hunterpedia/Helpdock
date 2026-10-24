import type { StaffRole } from '@helpdock/schemas';
import {
  aiRoute,
  automationRoute,
  brandRoute,
  channelsRoute,
  developersRoute,
  ROUTES,
  ticketingRoute,
} from '../app/route-paths.js';
import { aiTabsFor } from '../screens/admin/ai/tabs.js';
import { tabsFor as automationTabsFor } from '../screens/admin/automation/tabs.js';
import { channelsTabsFor } from '../screens/admin/channels/tabs.js';
import { NAV_BY_KEY, type NavKey, navFor } from './nav-items.js';

/**
 * The map of the Settings area (M14-21, `Admin/Settings-Shell`): seven groups
 * and the pages in each, in the board's order.
 *
 * Every page keeps the visibility rule it had before the move, by asking the
 * same function: the sidebar item the page lived under (`navFor`), then the
 * tab's own roles where the page had a tab row (`automationTabsFor`,
 * `channelsTabsFor`, `aiTabsFor`). Nothing here is a permission; like the
 * sidebar it keeps a person from clicking into a page that would answer 403,
 * and the api refuses whatever the navigation shows (DOMAIN-RULES §1.3).
 */

export type SettingsGroupId =
  | 'account'
  | 'brand'
  | 'inbox'
  | 'channels'
  | 'ai'
  | 'developers'
  | 'install';

export interface SettingsViewer {
  readonly role: StaffRole;
  readonly installAdmin: boolean;
}

/** A `namespace:key` of the catalogs, resolved by the shell with `t(key as never)`. */
type CatalogKey = `${string}:${string}`;

export interface SettingsEntry {
  /** Also the id of the entry's command palette page and its keywords. */
  readonly id: string;
  readonly group: SettingsGroupId;
  readonly path: string;
  readonly labelKey: CatalogKey;
  /** The Danger zone is drawn in the danger hue (DESIGN §2.3). */
  readonly danger?: true;
  readonly visibleTo: (viewer: SettingsViewer) => boolean;
}

export const SETTINGS_GROUPS: readonly SettingsGroupId[] = [
  'account',
  'brand',
  'inbox',
  'channels',
  'ai',
  'developers',
  'install',
];

export const settingsGroupLabelKey = (group: SettingsGroupId): CatalogKey =>
  `admin:settings.groups.${group}`;

const everyone = (): boolean => true;

/** The sidebar item the page lived under, for the roles and install-admin flag it declared. */
const offeredBy =
  (key: NavKey) =>
  (viewer: SettingsViewer): boolean =>
    navFor([NAV_BY_KEY[key]], viewer).length > 0;

const automationEntry =
  (segment: string) =>
  (viewer: SettingsViewer): boolean =>
    automationTabsFor(viewer.role).some((tab) => tab.segment === segment);

const channelsEntry =
  (segment: string) =>
  (viewer: SettingsViewer): boolean =>
    channelsTabsFor(viewer.role).some((tab) => tab.segment === segment);

const aiEntry =
  (segment: string) =>
  (viewer: SettingsViewer): boolean =>
    aiTabsFor(viewer).some((tab) => tab.segment === segment);

const installAdminOnly = (viewer: SettingsViewer): boolean => viewer.installAdmin;

const entry = (
  id: string,
  group: SettingsGroupId,
  path: string,
  labelKey: CatalogKey,
  visibleTo: SettingsEntry['visibleTo'],
  extra: { danger?: true } = {},
): SettingsEntry => ({ id, group, path, labelKey, visibleTo, ...extra });

const ticketing = (id: string, segment: string, labelKey: CatalogKey): SettingsEntry =>
  entry(id, 'inbox', ticketingRoute(segment), labelKey, offeredBy('ticketing'));

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  entry('accountProfile', 'account', ROUTES.meProfile, 'me:account.tabs.profile', everyone),
  entry(
    'yourNotifications',
    'account',
    ROUTES.meNotifications,
    'me:account.tabs.notifications',
    everyone,
  ),
  entry('accountSecurity', 'account', ROUTES.security, 'me:account.tabs.security', everyone),
  entry('accountSignature', 'account', ROUTES.signature, 'me:account.tabs.signature', everyone),

  entry('brandGeneral', 'brand', brandRoute('general'), 'brand:tabs.general', offeredBy('brand')),
  entry('brandDomains', 'brand', brandRoute('domains'), 'brand:tabs.domains', offeredBy('brand')),
  entry('brandDanger', 'brand', brandRoute('danger'), 'brand:tabs.danger', offeredBy('brand'), {
    danger: true,
  }),

  ticketing('ticketingDepartments', 'departments', 'ticketing:tabs.departments'),
  ticketing('ticketingStatuses', 'statuses', 'ticketing:tabs.statuses'),
  ticketing('ticketingPriorities', 'priorities', 'ticketing:tabs.priorities'),
  ticketing('ticketingTags', 'tags', 'ticketing:tabs.tags'),
  ticketing('ticketingCustomFields', 'custom-fields', 'ticketing:tabs.customFields'),
  ticketing('ticketingTemplates', 'templates', 'ticketing:tabs.templates'),
  ticketing('ticketingViews', 'views', 'ticketing:tabs.views'),
  ticketing('ticketingAssignment', 'assignment', 'ticketing:tabs.assignment'),
  ticketing('ticketingBusinessHours', 'business-hours', 'ticketing:tabs.businessHours'),
  ticketing('ticketingSlas', 'slas', 'admin:settings.entries.slas'),
  ticketing('ticketingSpam', 'spam', 'ticketing:tabs.spam'),
  ticketing('ticketingFeedback', 'feedback', 'ticketing:tabs.feedback'),
  entry(
    'automationRules',
    'inbox',
    automationRoute('rules'),
    'rules:tabs.rules',
    automationEntry('rules'),
  ),
  entry(
    'automationTimeBased',
    'inbox',
    automationRoute('time-based'),
    'rules:tabs.timeBased',
    automationEntry('time-based'),
  ),
  entry(
    'automationMacros',
    'inbox',
    automationRoute('macros'),
    'rules:tabs.macros',
    automationEntry('macros'),
  ),
  entry(
    'automationRouting',
    'inbox',
    automationRoute('routing'),
    'rules:tabs.routing',
    automationEntry('routing'),
  ),

  entry(
    'channelsMailboxes',
    'channels',
    channelsRoute('mailboxes'),
    'admin:settings.entries.mailboxes',
    channelsEntry('mailboxes'),
  ),
  entry(
    'channelsOutgoing',
    'channels',
    channelsRoute('outgoing'),
    'channels:tabs.outgoing',
    channelsEntry('outgoing'),
  ),
  entry(
    'channelsTelegram',
    'channels',
    channelsRoute('telegram'),
    'channels:tabs.telegram',
    channelsEntry('telegram'),
  ),
  entry(
    'channelsMeta',
    'channels',
    channelsRoute('meta'),
    'admin:settings.entries.meta',
    channelsEntry('meta'),
  ),
  entry(
    'channelsWidget',
    'channels',
    channelsRoute('widget'),
    'admin:settings.entries.widget',
    channelsEntry('widget'),
  ),
  entry(
    'channelsWebForm',
    'channels',
    channelsRoute('web-form'),
    'channels:tabs.webForm',
    channelsEntry('web-form'),
  ),

  entry(
    'aiProviders',
    'ai',
    aiRoute('providers'),
    'aiSettings:tabs.providers',
    aiEntry('providers'),
  ),
  entry(
    'aiKnowledge',
    'ai',
    aiRoute('knowledge'),
    'aiSettings:tabs.knowledge',
    aiEntry('knowledge'),
  ),
  entry(
    'aiAssistant',
    'ai',
    aiRoute('assistant'),
    'aiSettings:tabs.assistant',
    aiEntry('assistant'),
  ),

  entry(
    'developersApi',
    'developers',
    developersRoute('api-keys'),
    'developers:tabs.apiKeys',
    offeredBy('developers'),
  ),
  entry(
    'developersWebhooks',
    'developers',
    developersRoute('webhooks'),
    'developers:tabs.webhooks',
    offeredBy('developers'),
  ),

  entry(
    'settings',
    'install',
    ROUTES.authentication,
    'settings:tabs.authentication',
    installAdminOnly,
  ),
  entry('sso', 'install', ROUTES.sso, 'sso:title', installAdminOnly),
  entry('staff', 'install', ROUTES.staff, 'admin:nav.staff', offeredBy('staff')),
  entry('system', 'install', ROUTES.system, 'admin:nav.system', installAdminOnly),
  entry(
    'brandImport',
    'install',
    ROUTES.imports,
    'admin:settings.entries.imports',
    offeredBy('brand'),
  ),
];

/** The entries this person is offered in `group`, in the board's order. */
export const entriesFor = (
  group: SettingsGroupId,
  viewer: SettingsViewer,
): readonly SettingsEntry[] =>
  SETTINGS_ENTRIES.filter((candidate) => candidate.group === group && candidate.visibleTo(viewer));

/** Every group with something in it for this person; an empty group is not drawn. */
export const settingsFor = (
  viewer: SettingsViewer,
): readonly { readonly group: SettingsGroupId; readonly entries: readonly SettingsEntry[] }[] =>
  SETTINGS_GROUPS.map((group) => ({ group, entries: entriesFor(group, viewer) })).filter(
    ({ entries }) => entries.length > 0,
  );

/** Where `/settings`, and a group's own path, lands: the first page the person is offered. */
export const firstSettingsPath = (viewer: SettingsViewer, group?: SettingsGroupId): string => {
  const first = SETTINGS_ENTRIES.find(
    (candidate) =>
      (group === undefined || candidate.group === group) && candidate.visibleTo(viewer),
  );
  return first?.path ?? ROUTES.meProfile;
};

const isWithin = (pathname: string, path: string): boolean =>
  pathname === path || pathname.startsWith(`${path}/`);

/**
 * The entry a path belongs to: the page itself, or a page deeper under it (a
 * rule's builder under Rules, one mailbox under Email, the audit log under
 * System). The longest path wins so a nested entry is not shadowed by its
 * parent.
 */
export const settingsEntryAt = (pathname: string): SettingsEntry | undefined =>
  SETTINGS_ENTRIES.filter((candidate) => isWithin(pathname, candidate.path)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0];
