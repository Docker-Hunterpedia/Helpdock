import {
  BookOpen,
  ChartColumn,
  type LucideIcon,
  Server,
  Settings,
  ShieldUser,
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
  | 'staff'
  | 'system';

export interface NavItem {
  readonly key: NavKey;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly labelKey: `admin:nav.${NavKey}`;
  readonly captionKey: `admin:pages.caption.${NavKey}`;
  readonly emptyKey: `admin:pages.empty.body.${NavKey}`;
}

const item = (key: NavKey, path: string, icon: LucideIcon): NavItem => ({
  key,
  path,
  icon,
  labelKey: `admin:nav.${key}`,
  captionKey: `admin:pages.caption.${key}`,
  emptyKey: `admin:pages.empty.body.${key}`,
});

export const NAV_BY_KEY: Record<NavKey, NavItem> = {
  tickets: item('tickets', ROUTES.tickets, Ticket),
  contacts: item('contacts', ROUTES.contacts, Users),
  helpCenter: item('helpCenter', ROUTES.helpCenter, BookOpen),
  reports: item('reports', ROUTES.reports, ChartColumn),
  settings: item('settings', ROUTES.settings, Settings),
  staff: item('staff', ROUTES.staff, ShieldUser),
  system: item('system', ROUTES.system, Server),
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
  NAV_BY_KEY.staff,
  NAV_BY_KEY.system,
];

export const ALL_NAV: readonly NavItem[] = [...PRIMARY_NAV, ...ADMIN_NAV];
