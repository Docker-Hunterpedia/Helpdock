import arAdmin from '../locales/ar/admin.json' with { type: 'json' };
import arAiSettings from '../locales/ar/aiSettings.json' with { type: 'json' };
import arAuth from '../locales/ar/auth.json' with { type: 'json' };
import arBrand from '../locales/ar/brand.json' with { type: 'json' };
import arChannels from '../locales/ar/channels.json' with { type: 'json' };
import arCommon from '../locales/ar/common.json' with { type: 'json' };
import arContacts from '../locales/ar/contacts.json' with { type: 'json' };
import arCsat from '../locales/ar/csat.json' with { type: 'json' };
import arEmail from '../locales/ar/email.json' with { type: 'json' };
import arHcSite from '../locales/ar/hcSite.json' with { type: 'json' };
import arHelpCenter from '../locales/ar/helpCenter.json' with { type: 'json' };
import arMacros from '../locales/ar/macros.json' with { type: 'json' };
import arMe from '../locales/ar/me.json' with { type: 'json' };
import arReports from '../locales/ar/reports.json' with { type: 'json' };
import arRules from '../locales/ar/rules.json' with { type: 'json' };
import arSettings from '../locales/ar/settings.json' with { type: 'json' };
import arStaff from '../locales/ar/staff.json' with { type: 'json' };
import arSystem from '../locales/ar/system.json' with { type: 'json' };
import arTelegram from '../locales/ar/telegram.json' with { type: 'json' };
import arTicket from '../locales/ar/ticket.json' with { type: 'json' };
import arTicketing from '../locales/ar/ticketing.json' with { type: 'json' };
import arTickets from '../locales/ar/tickets.json' with { type: 'json' };
import arWebform from '../locales/ar/webform.json' with { type: 'json' };
import arWidget from '../locales/ar/widget.json' with { type: 'json' };
import arWizard from '../locales/ar/wizard.json' with { type: 'json' };
import enAdmin from '../locales/en/admin.json' with { type: 'json' };
import enAiSettings from '../locales/en/aiSettings.json' with { type: 'json' };
import enAuth from '../locales/en/auth.json' with { type: 'json' };
import enBrand from '../locales/en/brand.json' with { type: 'json' };
import enChannels from '../locales/en/channels.json' with { type: 'json' };
import enCommon from '../locales/en/common.json' with { type: 'json' };
import enContacts from '../locales/en/contacts.json' with { type: 'json' };
import enCsat from '../locales/en/csat.json' with { type: 'json' };
import enEmail from '../locales/en/email.json' with { type: 'json' };
import enHcSite from '../locales/en/hcSite.json' with { type: 'json' };
import enHelpCenter from '../locales/en/helpCenter.json' with { type: 'json' };
import enMacros from '../locales/en/macros.json' with { type: 'json' };
import enMe from '../locales/en/me.json' with { type: 'json' };
import enReports from '../locales/en/reports.json' with { type: 'json' };
import enRules from '../locales/en/rules.json' with { type: 'json' };
import enSettings from '../locales/en/settings.json' with { type: 'json' };
import enStaff from '../locales/en/staff.json' with { type: 'json' };
import enSystem from '../locales/en/system.json' with { type: 'json' };
import enTelegram from '../locales/en/telegram.json' with { type: 'json' };
import enTicket from '../locales/en/ticket.json' with { type: 'json' };
import enTicketing from '../locales/en/ticketing.json' with { type: 'json' };
import enTickets from '../locales/en/tickets.json' with { type: 'json' };
import enWebform from '../locales/en/webform.json' with { type: 'json' };
import enWidget from '../locales/en/widget.json' with { type: 'json' };
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
  // `Admin/Channels` (M2-08): Mailboxes and Outgoing email.
  'channels',
  // `Admin/Automation` (M3-03 to M3-05): workflow rules, their log and the test run.
  'rules',
  // M3-06: the Macros tab of Automation and the composer's macro picker.
  'macros',
  // M4: the chat widget on customer sites (`apps/widget`), read by the visitor.
  'widget',
  // The hosted web form (M4-09): read by the customer, not by staff.
  'webform',
  // `Admin/HelpCenter` and its editor (M5-01, M5-02, M5-09).
  'helpCenter',
  // The published help center (M5-03 to M5-06): read by visitors and staff on the brand's host.
  'hcSite',
  // M6-04: what a Telegram bot says to a customer, and the word a shared
  // location is filed under. Read by the customer, in their language.
  'telegram',
  // `Admin/AI` (M7-10): Providers, Knowledge and Assistant.
  'aiSettings',
  // `Admin/Reports` (M8-04).
  'reports',
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
    channels: enChannels,
    rules: enRules,
    macros: enMacros,
    widget: enWidget,
    webform: enWebform,
    helpCenter: enHelpCenter,
    hcSite: enHcSite,
    telegram: enTelegram,
    aiSettings: enAiSettings,
    reports: enReports,
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
    channels: arChannels,
    rules: arRules,
    macros: arMacros,
    widget: arWidget,
    webform: arWebform,
    helpCenter: arHelpCenter,
    hcSite: arHcSite,
    telegram: arTelegram,
    aiSettings: arAiSettings,
    reports: arReports,
  },
};

export type Resources = typeof resources;
/** English is the reference shape: `ar` is checked against it by the parity test. */
export type CatalogShape = Resources['en'];
