import type { StaffRole } from '@helpdock/schemas';
import {
  BookOpen,
  Building2,
  ChartColumn,
  type LucideIcon,
  Settings,
  Ticket,
  User,
  Users,
} from 'lucide-react';
import { helpCenterRoute, ROUTES } from '../app/route-paths.js';
import { helpCenterTabsFor } from '../screens/help-center/tabs.js';
import { NAV_BY_KEY, type NavKey, navFor } from './nav-items.js';
import {
  firstSettingsPath,
  SETTINGS_GROUP_ICONS,
  type SettingsEntry,
  type SettingsGroupId,
  settingsEntryAt,
  settingsFor,
  settingsGroupLabelKey,
} from './settings-nav.js';

/**
 * The sidebar's one tree (`Admin/UX-Fixes-2026-11`): five sections, each either
 * a plain link (Reports), a list of pages (Contacts, Help center), the ticket
 * views (Tickets) or Settings' groups of pages. Pure data, so what each person
 * is offered and which branch a path belongs to are tested without a browser.
 */

export type SectionKey = 'tickets' | 'contacts' | 'helpCenter' | 'reports' | 'settings';

/** `namespace:key` of the catalogs, resolved with `t(key as never)`. */
type CatalogKey = `${string}:${string}`;

export interface TreeLeaf {
  readonly id: string;
  readonly path: string;
  readonly labelKey: CatalogKey;
  readonly icon: LucideIcon;
  readonly danger?: true;
  /** Whether this pathname is the page, including pages deeper under it. */
  readonly isCurrent: (pathname: string) => boolean;
}

export interface TreeGroup {
  readonly id: SettingsGroupId;
  readonly labelKey: CatalogKey;
  readonly icon: LucideIcon;
  readonly leaves: readonly TreeLeaf[];
}

export interface TreeSection {
  readonly key: SectionKey;
  readonly icon: LucideIcon;
  readonly labelKey: `admin:nav.${NavKey}`;
  /** Where a click on the row goes: the section's first page. */
  readonly path: string;
  /** The NavKey whose count and role rule this section follows. */
  readonly nav: NavKey;
  readonly kind: 'link' | 'views' | 'leaves' | 'groups';
  readonly leaves: readonly TreeLeaf[];
  readonly groups: readonly TreeGroup[];
}

const within = (pathname: string, path: string): boolean =>
  pathname === path || pathname.startsWith(`${path}/`);

export interface TreeViewer {
  readonly role: StaffRole;
  readonly installAdmin: boolean;
}

const settingsLeaf = (entry: SettingsEntry): TreeLeaf => ({
  id: entry.id,
  path: entry.path,
  labelKey: entry.labelKey,
  icon: entry.icon,
  ...(entry.danger === true ? { danger: true as const } : {}),
  isCurrent: (pathname) => settingsEntryAt(pathname)?.id === entry.id,
});

/** The sections this person is offered, in the sidebar's order. */
export function sectionsFor(viewer: TreeViewer): readonly TreeSection[] {
  const offered = (key: NavKey): boolean => navFor([NAV_BY_KEY[key]], viewer).length > 0;
  const sections: TreeSection[] = [];

  if (offered('tickets')) {
    sections.push({
      key: 'tickets',
      icon: Ticket,
      labelKey: 'admin:nav.tickets',
      path: ROUTES.tickets,
      nav: 'tickets',
      kind: 'views',
      leaves: [],
      groups: [],
    });
  }
  if (offered('contacts')) {
    sections.push({
      key: 'contacts',
      icon: Users,
      labelKey: 'admin:nav.contacts',
      path: ROUTES.contacts,
      nav: 'contacts',
      kind: 'leaves',
      leaves: [
        {
          id: 'people',
          path: ROUTES.contacts,
          labelKey: 'contacts:segment.people',
          icon: User,
          isCurrent: (pathname) =>
            within(pathname, ROUTES.contacts) && !within(pathname, ROUTES.contactsAccounts),
        },
        {
          id: 'accounts',
          path: ROUTES.contactsAccounts,
          labelKey: 'contacts:segment.accounts',
          icon: Building2,
          isCurrent: (pathname) => within(pathname, ROUTES.contactsAccounts),
        },
      ],
      groups: [],
    });
  }
  if (offered('helpCenter')) {
    const tabs = helpCenterTabsFor(viewer.role);
    sections.push({
      key: 'helpCenter',
      icon: BookOpen,
      labelKey: 'admin:nav.helpCenter',
      path: helpCenterRoute(tabs[0]?.key ?? 'articles'),
      nav: 'helpCenter',
      kind: 'leaves',
      leaves: tabs.map((tab) => ({
        id: tab.key,
        path: helpCenterRoute(tab.key),
        labelKey: `helpCenter:tabs.${tab.key}`,
        icon: tab.icon,
        isCurrent: (pathname) => within(pathname, helpCenterRoute(tab.key)),
      })),
      groups: [],
    });
  }
  if (offered('reports')) {
    sections.push({
      key: 'reports',
      icon: ChartColumn,
      labelKey: 'admin:nav.reports',
      path: ROUTES.reports,
      nav: 'reports',
      kind: 'link',
      leaves: [],
      groups: [],
    });
  }
  if (offered('settings')) {
    sections.push({
      key: 'settings',
      icon: Settings,
      labelKey: 'admin:nav.settings',
      path: firstSettingsPath(viewer),
      nav: 'settings',
      kind: 'groups',
      leaves: [],
      groups: settingsFor(viewer).map(({ group, entries }) => ({
        id: group,
        labelKey: settingsGroupLabelKey(group),
        icon: SETTINGS_GROUP_ICONS[group],
        leaves: entries.map(settingsLeaf),
      })),
    });
  }

  return sections;
}

/** The section a path belongs to, or null for a page outside the five (not found, a wizard). */
export function sectionAt(pathname: string): SectionKey | null {
  if (within(pathname, ROUTES.tickets)) return 'tickets';
  if (within(pathname, ROUTES.contacts)) return 'contacts';
  if (within(pathname, ROUTES.helpCenter)) return 'helpCenter';
  if (within(pathname, ROUTES.reports)) return 'reports';
  if (within(pathname, ROUTES.settings)) return 'settings';
  return null;
}

/** The Settings group the path's page belongs to, so the tree can open it. */
export const settingsGroupAt = (pathname: string): SettingsGroupId | null =>
  settingsEntryAt(pathname)?.group ?? null;
