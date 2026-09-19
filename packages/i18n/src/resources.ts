import arAdmin from '../locales/ar/admin.json' with { type: 'json' };
import arAuth from '../locales/ar/auth.json' with { type: 'json' };
import arCommon from '../locales/ar/common.json' with { type: 'json' };
import arContacts from '../locales/ar/contacts.json' with { type: 'json' };
import arEmail from '../locales/ar/email.json' with { type: 'json' };
import arMe from '../locales/ar/me.json' with { type: 'json' };
import arSettings from '../locales/ar/settings.json' with { type: 'json' };
import arStaff from '../locales/ar/staff.json' with { type: 'json' };
import arSystem from '../locales/ar/system.json' with { type: 'json' };
import arTicketing from '../locales/ar/ticketing.json' with { type: 'json' };
import arWizard from '../locales/ar/wizard.json' with { type: 'json' };
import enAdmin from '../locales/en/admin.json' with { type: 'json' };
import enAuth from '../locales/en/auth.json' with { type: 'json' };
import enCommon from '../locales/en/common.json' with { type: 'json' };
import enContacts from '../locales/en/contacts.json' with { type: 'json' };
import enEmail from '../locales/en/email.json' with { type: 'json' };
import enMe from '../locales/en/me.json' with { type: 'json' };
import enSettings from '../locales/en/settings.json' with { type: 'json' };
import enStaff from '../locales/en/staff.json' with { type: 'json' };
import enSystem from '../locales/en/system.json' with { type: 'json' };
import enTicketing from '../locales/en/ticketing.json' with { type: 'json' };
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
  'me',
  'email',
  'system',
  'ticketing',
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
    me: enMe,
    email: enEmail,
    system: enSystem,
    ticketing: enTicketing,
  },
  ar: {
    common: arCommon,
    auth: arAuth,
    admin: arAdmin,
    wizard: arWizard,
    settings: arSettings,
    staff: arStaff,
    contacts: arContacts,
    me: arMe,
    email: arEmail,
    system: arSystem,
    ticketing: arTicketing,
  },
};

export type Resources = typeof resources;
/** English is the reference shape: `ar` is checked against it by the parity test. */
export type CatalogShape = Resources['en'];
