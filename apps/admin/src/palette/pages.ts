import type { StaffRole } from '@helpdock/schemas';
import {
  aiRoute,
  automationRoute,
  brandRoute,
  channelsRoute,
  developersRoute,
  helpCenterRoute,
  ROUTES,
  ticketingRoute,
} from '../app/route-paths.js';
import { NAV_BY_KEY, type NavKey, navFor } from '../shell/nav-items.js';

/**
 * The palette's "Go to" registry (M14-05): every page and every settings tab
 * a person can reach from the sidebar, with the words they might look for it
 * by. It is a hand-kept list, and `pages.test.ts` fails when a route of
 * `route-paths.ts` or a tab of any settings page is neither here nor excluded
 * there, so a new screen cannot ship out of the palette's reach.
 *
 * Titles are existing catalog keys, joined as `Area › Tab`; the words people
 * search by live in `admin:palette.keywords.<id>` in both languages, and the
 * palette matches a query against both languages' title and keywords whatever
 * language the interface is in.
 *
 * Visibility is the sidebar's: the area's `NavItem` (`navFor`) and, for the
 * tabs a role does not open, the tab's own `roles`. Like the sidebar it is
 * chrome and not a permission; the api refuses whatever the palette offers.
 */

/**
 * A `namespace:key` of the catalogs. Plain text rather than i18next's key union
 * because the registry is data; `pages.test.ts` resolves every one in both
 * languages, which is the check the union would have been.
 */
export type PageKey = `${string}:${string}`;

export interface PageEntry {
  readonly id: string;
  readonly path: string;
  /** Whose destination it is; a person not offered the area is not offered the page. */
  readonly area: NavKey | 'account';
  /** `[area]` or `[area, tab]`: catalog keys, drawn as `Area › Tab`. */
  readonly title: readonly [PageKey] | readonly [PageKey, PageKey];
  /** Settings pages are what the empty palette remembers; the primary pages are one key away. */
  readonly group: 'page' | 'settings';
  /** Roles that open this tab when the area opens for more of them. */
  readonly roles?: readonly StaffRole[];
  readonly installAdminOnly?: boolean;
}

const ALL_ROLES: readonly StaffRole[] = ['admin', 'teamLeader', 'agent', 'viewer'];

const primary = (
  id: string,
  area: NavKey,
  path: string,
  title: PageEntry['title'] = [`admin:nav.${area}`],
  roles?: readonly StaffRole[],
): PageEntry => ({
  id,
  area,
  path,
  title,
  group: 'page',
  ...(roles === undefined ? {} : { roles }),
});

const tabPage = (
  id: string,
  area: NavKey,
  path: string,
  tab: PageKey,
  extra: { roles?: readonly StaffRole[]; installAdminOnly?: boolean } = {},
): PageEntry => ({
  id,
  area,
  path,
  title: [`admin:nav.${area}`, tab],
  group: 'settings',
  ...extra,
});

export const PAGES: readonly PageEntry[] = [
  primary('tickets', 'tickets', ROUTES.tickets),
  primary('contacts', 'contacts', ROUTES.contacts),
  primary('contactNew', 'contacts', ROUTES.contactNew, [
    'admin:nav.contacts',
    'contacts:newContact',
  ]),
  primary('helpCenterArticles', 'helpCenter', ROUTES.helpCenter, [
    'admin:nav.helpCenter',
    'helpCenter:tabs.articles',
  ]),
  primary(
    'helpCenterProposals',
    'helpCenter',
    helpCenterRoute('proposals'),
    ['admin:nav.helpCenter', 'helpCenter:tabs.proposals'],
    ['admin', 'teamLeader'],
  ),
  primary(
    'helpCenterSettings',
    'helpCenter',
    helpCenterRoute('settings'),
    ['admin:nav.helpCenter', 'helpCenter:tabs.settings'],
    ['admin', 'teamLeader', 'viewer'],
  ),
  primary(
    'helpCenterInsights',
    'helpCenter',
    helpCenterRoute('insights'),
    ['admin:nav.helpCenter', 'helpCenter:tabs.insights'],
    ['admin', 'teamLeader', 'viewer'],
  ),
  primary('reports', 'reports', ROUTES.reports),

  {
    id: 'accountProfile',
    area: 'account',
    path: ROUTES.meProfile,
    title: ['me:account.title', 'me:account.tabs.profile'],
    group: 'settings',
  },
  {
    id: 'accountSecurity',
    area: 'account',
    path: ROUTES.security,
    title: ['me:account.title', 'me:account.tabs.security'],
    group: 'settings',
  },
  {
    id: 'accountNotifications',
    area: 'account',
    path: ROUTES.meNotifications,
    title: ['me:account.title', 'me:account.tabs.notifications'],
    group: 'settings',
  },
  {
    id: 'accountSignature',
    area: 'account',
    path: ROUTES.signature,
    title: ['me:account.title', 'me:account.tabs.signature'],
    group: 'settings',
  },

  {
    id: 'settings',
    area: 'settings',
    path: ROUTES.settings,
    title: ['admin:nav.settings'],
    group: 'settings',
    installAdminOnly: true,
  },

  tabPage('brandGeneral', 'brand', brandRoute('general'), 'brand:tabs.general'),
  tabPage('brandDomains', 'brand', brandRoute('domains'), 'brand:tabs.domains'),
  tabPage('brandImport', 'brand', brandRoute('import'), 'brand:tabs.import'),
  tabPage('brandDanger', 'brand', brandRoute('danger'), 'brand:tabs.danger'),

  tabPage(
    'ticketingDepartments',
    'ticketing',
    ticketingRoute('departments'),
    'ticketing:tabs.departments',
  ),
  tabPage('ticketingStatuses', 'ticketing', ticketingRoute('statuses'), 'ticketing:tabs.statuses'),
  tabPage(
    'ticketingPriorities',
    'ticketing',
    ticketingRoute('priorities'),
    'ticketing:tabs.priorities',
  ),
  tabPage('ticketingTags', 'ticketing', ticketingRoute('tags'), 'ticketing:tabs.tags'),
  tabPage(
    'ticketingCustomFields',
    'ticketing',
    ticketingRoute('custom-fields'),
    'ticketing:tabs.customFields',
  ),
  tabPage(
    'ticketingTemplates',
    'ticketing',
    ticketingRoute('templates'),
    'ticketing:tabs.templates',
  ),
  tabPage('ticketingViews', 'ticketing', ticketingRoute('views'), 'ticketing:tabs.views'),
  tabPage(
    'ticketingAssignment',
    'ticketing',
    ticketingRoute('assignment'),
    'ticketing:tabs.assignment',
  ),
  tabPage('ticketingSpam', 'ticketing', ticketingRoute('spam'), 'ticketing:tabs.spam'),
  tabPage('ticketingFeedback', 'ticketing', ticketingRoute('feedback'), 'ticketing:tabs.feedback'),
  tabPage(
    'ticketingBusinessHours',
    'ticketing',
    ticketingRoute('business-hours'),
    'ticketing:tabs.businessHours',
  ),
  tabPage('ticketingSlas', 'ticketing', ticketingRoute('slas'), 'ticketing:tabs.slas'),

  tabPage('automationRules', 'automation', automationRoute('rules'), 'rules:tabs.rules', {
    roles: ['admin', 'teamLeader'],
  }),
  tabPage(
    'automationTimeBased',
    'automation',
    automationRoute('time-based'),
    'rules:tabs.timeBased',
    {
      roles: ['admin', 'teamLeader'],
    },
  ),
  tabPage('automationRouting', 'automation', automationRoute('routing'), 'rules:tabs.routing', {
    roles: ['admin', 'teamLeader'],
  }),
  tabPage('automationMacros', 'automation', automationRoute('macros'), 'rules:tabs.macros', {
    roles: ['admin', 'teamLeader', 'agent'],
  }),

  tabPage('channelsMailboxes', 'channels', channelsRoute('mailboxes'), 'channels:tabs.mailboxes', {
    roles: ['admin'],
  }),
  tabPage('channelsOutgoing', 'channels', channelsRoute('outgoing'), 'channels:tabs.outgoing', {
    roles: ['admin'],
  }),
  tabPage('channelsWidget', 'channels', channelsRoute('widget'), 'channels:tabs.widget', {
    roles: ['admin', 'teamLeader'],
  }),
  tabPage('channelsWebForm', 'channels', channelsRoute('web-form'), 'channels:tabs.webForm', {
    roles: ['admin'],
  }),
  tabPage('channelsTelegram', 'channels', channelsRoute('telegram'), 'channels:tabs.telegram', {
    roles: ['admin'],
  }),
  tabPage('channelsMeta', 'channels', channelsRoute('meta'), 'channels:tabs.meta', {
    roles: ['admin'],
  }),

  tabPage('aiProviders', 'ai', aiRoute('providers'), 'aiSettings:tabs.providers', {
    installAdminOnly: true,
  }),
  tabPage('aiKnowledge', 'ai', aiRoute('knowledge'), 'aiSettings:tabs.knowledge', {
    roles: ['admin', 'teamLeader'],
  }),
  tabPage('aiAssistant', 'ai', aiRoute('assistant'), 'aiSettings:tabs.assistant', {
    roles: ['admin', 'teamLeader'],
  }),

  tabPage('developersApi', 'developers', developersRoute('api-keys'), 'developers:tabs.apiKeys'),
  tabPage(
    'developersWebhooks',
    'developers',
    developersRoute('webhooks'),
    'developers:tabs.webhooks',
  ),

  {
    id: 'staff',
    area: 'staff',
    path: ROUTES.staff,
    title: ['admin:nav.staff'],
    group: 'settings',
  },
  {
    id: 'system',
    area: 'system',
    path: ROUTES.system,
    title: ['admin:nav.system'],
    group: 'settings',
  },
  {
    id: 'systemAuditLog',
    area: 'system',
    path: ROUTES.systemAuditLog,
    title: ['admin:nav.system', 'system:auditLog.title'],
    group: 'settings',
  },
];

export interface PageViewer {
  readonly role: StaffRole;
  readonly installAdmin: boolean;
}

/** The pages this person is offered: the sidebar's rule, then the tab's own. */
export const pagesFor = (viewer: PageViewer): readonly PageEntry[] =>
  PAGES.filter((page) => {
    if (page.area !== 'account' && navFor([NAV_BY_KEY[page.area]], viewer).length === 0) {
      return false;
    }
    if (page.installAdminOnly === true && !viewer.installAdmin) {
      return false;
    }
    // An install-admin-only tab is the install admin's whatever their role.
    if (page.installAdminOnly === true) {
      return true;
    }
    return (page.roles ?? ALL_ROLES).includes(viewer.role);
  });

/** The page whose path is exactly `pathname`, for the palette to remember a visit. */
export const pageAt = (pathname: string): PageEntry | undefined =>
  PAGES.find((page) => page.path === pathname);
