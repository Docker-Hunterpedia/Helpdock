import arAdmin from '../locales/ar/admin.json' with { type: 'json' };
import arAuth from '../locales/ar/auth.json' with { type: 'json' };
import arBrand from '../locales/ar/brand.json' with { type: 'json' };
import arCommon from '../locales/ar/common.json' with { type: 'json' };
import arContacts from '../locales/ar/contacts.json' with { type: 'json' };
import arCsat from '../locales/ar/csat.json' with { type: 'json' };
import arEmail from '../locales/ar/email.json' with { type: 'json' };
import arMe from '../locales/ar/me.json' with { type: 'json' };
import arSettings from '../locales/ar/settings.json' with { type: 'json' };
import arStaff from '../locales/ar/staff.json' with { type: 'json' };
import arSystem from '../locales/ar/system.json' with { type: 'json' };
import arTicket from '../locales/ar/ticket.json' with { type: 'json' };
import arTicketing from '../locales/ar/ticketing.json' with { type: 'json' };
import arTickets from '../locales/ar/tickets.json' with { type: 'json' };
import arWizard from '../locales/ar/wizard.json' with { type: 'json' };
import enAdmin from '../locales/en/admin.json' with { type: 'json' };
import enAuth from '../locales/en/auth.json' with { type: 'json' };
import enBrand from '../locales/en/brand.json' with { type: 'json' };
import enCommon from '../locales/en/common.json' with { type: 'json' };
import enContacts from '../locales/en/contacts.json' with { type: 'json' };
import enCsat from '../locales/en/csat.json' with { type: 'json' };
import enEmail from '../locales/en/email.json' with { type: 'json' };
import enMe from '../locales/en/me.json' with { type: 'json' };
import enSettings from '../locales/en/settings.json' with { type: 'json' };
import enStaff from '../locales/en/staff.json' with { type: 'json' };
import enSystem from '../locales/en/system.json' with { type: 'json' };
import enTicket from '../locales/en/ticket.json' with { type: 'json' };
import enTicketing from '../locales/en/ticketing.json' with { type: 'json' };
import enTickets from '../locales/en/tickets.json' with { type: 'json' };
import enWizard from '../locales/en/wizard.json' with { type: 'json' };

/** DESIGN §7 and REQUIREMENTS: English and Modern Standard Arabic in v1. */
export const SUPPORTED_LNGS = ['en', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LNGS)[number];

export const FALLBACK_LNG = 'en' as const;

/** One namespace per screen area, so a screen loads only what it shows. */
export const NAMESPACES = [
  'common',
  'auth',
  'admin',
  'wizard',
  'settings',
  'staff',
  'contacts',
  'tickets',
  'me',
  'email',
  'system',
  'ticketing',
  // `Admin/Brand` (M1-14 ships its Danger zone tab).
  'brand',
  // Not a screen: the system messages the api writes into a ticket thread, in
  // the contact's language rather than the reader's (M1-08, DOMAIN-RULES §2.3).
  'ticket',
  // The public rating page (M1-12): read by the customer, not by staff.
  'csat',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NS = 'common' as const;

export const resources = {
  en: {
    common: enCommon,
    auth: enAuth,
    admin: enAdmin,
    wizard: enWizard,
    settings: enSettings,
    staff: enStaff,
    contacts: enContacts,
    tickets: enTickets,
    me: enMe,
    email: enEmail,
    system: enSystem,
    ticketing: enTicketing,
    brand: enBrand,
    ticket: enTicket,
    csat: enCsat,
  },
  ar: {
    common: arCommon,
    auth: arAuth,
    admin: arAdmin,
    wizard: arWizard,
    settings: arSettings,
    staff: arStaff,
    contacts: arContacts,
    tickets: arTickets,
    me: arMe,
    email: arEmail,
    system: arSystem,
    ticketing: arTicketing,
    brand: arBrand,
    ticket: arTicket,
    csat: arCsat,
  },
};

export type Resources = typeof resources;
/** English is the reference shape: `ar` is checked against it by the parity test. */
export type CatalogShape = Resources['en'];
