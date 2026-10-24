import type { StaffRole } from '@helpdock/schemas';
import { helpCenterRoute, ROUTES } from '../app/route-paths.js';
import { NAV_BY_KEY, type NavKey, navFor } from '../shell/nav-items.js';
import {
  SETTINGS_ENTRIES,
  type SettingsEntry,
  type SettingsViewer,
  settingsGroupLabelKey,
} from '../shell/settings-nav.js';

/**
 * The palette's "Go to" registry (M14-05): every page and every settings page
 * a person can reach from the sidebar, with the words they might look for it
 * by. The primary pages are a hand-kept list and the settings pages are the
 * Settings area's own entries (`settings-nav.ts`), so the palette follows the
 * structure of M14-21. `pages.test.ts` fails when a route of `route-paths.ts`
 * is neither here nor excluded there, so a new screen cannot ship out of the
 * palette's reach.
 *
 * Titles are existing catalog keys, joined as `Group › Page`; the words people
 * search by live in `admin:palette.keywords.<id>` in both languages, and the
 * palette matches a query against both languages' title and keywords whatever
 * language the interface is in.
 *
 * Visibility is the sidebar's for the primary pages (`navFor`, then the tab's
 * own `roles`) and the settings entry's own rule for the rest. Like the sidebar
 * it is chrome and not a permission; the api refuses whatever the palette
 * offers.
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
  /** Whose destination a primary page is; a person not offered the area is not offered the page. */
  readonly area?: NavKey;
  /** `[page]` or `[group, page]`: catalog keys, drawn as `Group › Page`. */
  readonly title: readonly [PageKey] | readonly [PageKey, PageKey];
  /** Settings pages are what the empty palette remembers; the primary pages are one key away. */
  readonly group: 'page' | 'settings';
  /** Roles that open this primary page when its area opens for more of them. */
  readonly roles?: readonly StaffRole[];
  /** A settings page's own rule, which replaces the area and roles above. */
  readonly visibleTo?: (viewer: SettingsViewer) => boolean;
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

const settingsPage = (entry: SettingsEntry): PageEntry => ({
  id: entry.id,
  path: entry.path,
  title: [settingsGroupLabelKey(entry.group), entry.labelKey],
  group: 'settings',
  visibleTo: entry.visibleTo,
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

  ...SETTINGS_ENTRIES.map(settingsPage),

  {
    id: 'systemAuditLog',
    path: ROUTES.systemAuditLog,
    title: [settingsGroupLabelKey('install'), 'system:auditLog.title'],
    group: 'settings',
    visibleTo: (viewer) => viewer.installAdmin,
  },
];

export type PageViewer = SettingsViewer;

/** The pages this person is offered: the sidebar's rule, then the tab's own. */
export const pagesFor = (viewer: PageViewer): readonly PageEntry[] =>
  PAGES.filter((page) => {
    if (page.visibleTo !== undefined) {
      return page.visibleTo(viewer);
    }
    if (page.area !== undefined && navFor([NAV_BY_KEY[page.area]], viewer).length === 0) {
      return false;
    }
    return (page.roles ?? ALL_ROLES).includes(viewer.role);
  });

/** The page whose path is exactly `pathname`, for the palette to remember a visit. */
export const pageAt = (pathname: string): PageEntry | undefined =>
  PAGES.find((page) => page.path === pathname);
