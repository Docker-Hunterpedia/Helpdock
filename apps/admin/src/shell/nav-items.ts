import type { StaffRole } from '@helpdock/schemas';
import {
  BookOpen,
  ChartColumn,
  type LucideIcon,
  Server,
  Settings,
  ShieldUser,
  SlidersHorizontal,
  Ticket,
  Users,
} from 'lucide-react';
import { ROUTES } from '../app/route-paths.js';

/** Also the key the api uses for that item's count and the page's copy. */
export type NavKey =
  | 'tickets'
  | 'contacts'
  | 'helpCenter'
  | 'reports'
  | 'settings'
  | 'ticketing'
  | 'staff'
  | 'system';

export interface NavItem {
  readonly key: NavKey;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly labelKey: `admin:nav.${NavKey}`;
  readonly captionKey: `admin:pages.caption.${NavKey}`;
  readonly emptyKey: `admin:pages.empty.body.${NavKey}`;
  /**
   * Roles this destination is drawn for. Absent means everybody who can sign
   * in. It is chrome, not a permission: the api refuses the request whatever
   * the sidebar shows (DOMAIN-RULES §1.3), and this only keeps a person from
   * clicking into a page that would answer 403.
   */
  readonly roles?: readonly StaffRole[];
  /** Install-wide destinations, offered to an install admin alone (M0-10). */
  readonly installAdminOnly?: boolean;
  /**
   * True while this destination is still the "arrives with milestone N" page.
   * The router builds the placeholder routes from this, so a screen that
   * becomes real is declared in one place — a hand-kept exclusion list would
   * eventually register two routes on one path, which React Router resolves by
   * ranking rather than by failing.
   */
  readonly placeholder?: boolean;
}

const item = (
  key: NavKey,
  path: string,
  icon: LucideIcon,
  visibility: {
    roles?: readonly StaffRole[];
    installAdminOnly?: boolean;
    placeholder?: boolean;
  } = {},
): NavItem => ({
  key,
  path,
  icon,
  labelKey: `admin:nav.${key}`,
  captionKey: `admin:pages.caption.${key}`,
  emptyKey: `admin:pages.empty.body.${key}`,
  ...(visibility.roles === undefined ? {} : { roles: visibility.roles }),
  ...(visibility.installAdminOnly === true ? { installAdminOnly: true } : {}),
  ...(visibility.placeholder === true ? { placeholder: true } : {}),
});

export const NAV_BY_KEY: Record<NavKey, NavItem> = {
  tickets: item('tickets', ROUTES.tickets, Ticket, { placeholder: true }),
  contacts: item('contacts', ROUTES.contacts, Users),
  helpCenter: item('helpCenter', ROUTES.helpCenter, BookOpen, { placeholder: true }),
  reports: item('reports', ROUTES.reports, ChartColumn, { placeholder: true }),
  settings: item('settings', ROUTES.settings, Settings, { placeholder: true }),
  // How this brand's tickets are shaped and routed (M1-01). Offered to the two
  // roles that may change any of it: an Admin everywhere, a Team Leader in the
  // departments they lead (DOMAIN-RULES §1.2).
  ticketing: item('ticketing', ROUTES.ticketing, SlidersHorizontal, {
    roles: ['admin', 'teamLeader'],
  }),
  // "Staff and roles" is the Admin and Team Leader screen: they are the two
  // roles that hold `staff:manage` (DOMAIN-RULES §1.2).
  staff: item('staff', ROUTES.staff, ShieldUser, { roles: ['admin', 'teamLeader'] }),
  // The System page is install-wide — schema, queues, the database role — so
  // only an install admin is offered it.
  system: item('system', ROUTES.system, Server, { installAdminOnly: true }),
};

/** DESIGN §6.5: the primary group, then the "Admin" group under its label. */
export const PRIMARY_NAV: readonly NavItem[] = [
  NAV_BY_KEY.tickets,
  NAV_BY_KEY.contacts,
  NAV_BY_KEY.helpCenter,
  NAV_BY_KEY.reports,
];

export const ADMIN_NAV: readonly NavItem[] = [
  NAV_BY_KEY.settings,
  NAV_BY_KEY.ticketing,
  NAV_BY_KEY.staff,
  NAV_BY_KEY.system,
];

export const ALL_NAV: readonly NavItem[] = [...PRIMARY_NAV, ...ADMIN_NAV];

/**
 * The destinations this person is offered.
 *
 * It is chrome, not a permission. A brand admin who types `/admin/system`
 * anyway is refused by the api and the screen draws that refusal; the nav only
 * keeps somebody from clicking into a page that would answer 403
 * (DOMAIN-RULES §1.3).
 */
export const navFor = (
  items: readonly NavItem[],
  viewer: { readonly role: StaffRole; readonly installAdmin: boolean },
): readonly NavItem[] =>
  items.filter(
    (item) =>
      (item.roles === undefined || item.roles.includes(viewer.role)) &&
      (item.installAdminOnly !== true || viewer.installAdmin),
  );
