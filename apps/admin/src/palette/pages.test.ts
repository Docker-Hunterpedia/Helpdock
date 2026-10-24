import { resources, SUPPORTED_LNGS } from '@helpdock/i18n';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../app/route-paths.js';
import { ACCOUNT_TABS } from '../screens/account/account-page.tsx';
import { AI_TABS } from '../screens/admin/ai/tabs.js';
import { AUTOMATION_TABS } from '../screens/admin/automation/tabs.js';
import { BRAND_TABS } from '../screens/admin/brand/brand-page.tsx';
import { CHANNELS_TABS } from '../screens/admin/channels/tabs.js';
import { DEVELOPERS_TABS } from '../screens/admin/developers/developers-page.tsx';
import { TICKETING_TABS } from '../screens/admin/ticketing/tabs.js';
import { helpCenterTabsFor } from '../screens/help-center/help-center-page.tsx';
import { PAGES, pageAt, pagesFor } from './pages.js';

/**
 * The registry is a hand-kept list, so these tests are what keeps it whole:
 * every route and every tab is in it or named here as left out, every title
 * and keyword exists in both languages, and a person is offered what the
 * sidebar and the tab row offer them.
 */

/** Routes with no page of their own to go to, and why. */
const NOT_A_DESTINATION: Readonly<Record<keyof typeof ROUTES, string>> = {
  setup: 'the first-run wizard, mounted only while the install is fresh',
  signIn: 'signed out',
  totp: 'signed out',
  magicLinkSent: 'signed out',
  magicLink: 'signed out',
  authComplete: 'signed out',
  passwordResetSent: 'signed out',
  passwordReset: 'signed out',
  totpEnrolment: 'signed out',
  acceptInvite: 'signed out',
  oauthCallback: 'signed out',
  ticket: 'one ticket: found through quick search',
  ticketWorkspace: 'the router’s own pattern for the two above',
  contact: 'one contact: found through quick search',
  account: 'one account of contacts, reached from a contact',
  helpCenterTab: 'the family of the Help center tabs, each in the registry',
  helpCenterArticle: 'one article: found through quick search',
  helpCenterOpen: 'leaves for the public help center rather than showing a page',
  ssoConnection: 'one SSO connection, reached from Settings',
  inboxTab: 'the family of the Inbox pages, each in the registry',
  ticketing: 'the Inbox prefix under its old area name; every page is in the registry',
  automation: 'the Inbox prefix under its old area name; every page is in the registry',
  automationRule: 'one rule’s builder, reached from the Rules tab',
  importRun: 'one import run, reached from Install › Imports',
  brandTab: 'the family of the Brand tabs, each in the registry',
  channelsTab: 'the family of the Channels tabs, each in the registry',
  mailboxNew: 'a form reached from Channels › Mailboxes',
  mailbox: 'one mailbox, reached from Channels › Mailboxes',
  ai: 'redirects to the first AI tab the reader has',
  aiTab: 'the family of the AI tabs, each in the registry',
  telegramBot: 'one bot, reached from Channels › Telegram',
  metaAccount: 'one account, reached from Channels › Meta',
  developers: 'redirects to API keys',
  developersTab: 'the family of the Developers tabs, each in the registry',
  systemQueues: 'the queue dashboard, reached from System',
  myAccount: 'redirects to Profile',
  myAccountTab: 'the family of the account pages, each in the registry',
  csat: 'the public rating page, not a staff screen',
  unsubscribe: 'the public unsubscribe page, not a staff screen',
  // Destinations that ARE in the registry are listed as such below.
  tickets: 'in the registry',
  contacts: 'in the registry',
  contactNew: 'in the registry',
  helpCenter: 'in the registry',
  reports: 'in the registry',
  settings: 'redirects to the first page the reader is offered',
  inbox: 'redirects to the first page the reader has; every page is in the registry',
  authentication: 'in the registry',
  sso: 'in the registry',
  imports: 'in the registry',
  brand: 'redirects to the first tab; every tab is in the registry',
  channels: 'redirects to the first tab; every tab is in the registry',
  staff: 'in the registry',
  system: 'in the registry',
  systemAuditLog: 'in the registry',
  meProfile: 'in the registry',
  security: 'in the registry',
  meNotifications: 'in the registry',
  signature: 'in the registry',
};

const paths = PAGES.map((page) => page.path);

describe('the page registry and the routes', () => {
  it('has every static route in the registry or says why it is not a destination', () => {
    const uncovered = Object.entries(ROUTES)
      .filter(([, path]) => !(paths as string[]).includes(path))
      .map(([name]) => name)
      .filter((name) => NOT_A_DESTINATION[name as keyof typeof ROUTES] === undefined);

    expect(uncovered).toEqual([]);
  });

  it('keeps no exclusion for a route that is gone, and says "in the registry" only where it is', () => {
    const names = Object.keys(ROUTES);
    expect(Object.keys(NOT_A_DESTINATION).filter((name) => !names.includes(name))).toEqual([]);

    const wrong = Object.entries(ROUTES)
      .filter(
        ([name, path]) =>
          (NOT_A_DESTINATION[name as keyof typeof ROUTES] === 'in the registry') !==
          (paths as string[]).includes(path),
      )
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('has a page for every tab of every settings page', () => {
    const tabPaths = [
      ...TICKETING_TABS.map((tab) => `${ROUTES.inbox}/${tab.segment}`),
      ...AUTOMATION_TABS.map((tab) => `${ROUTES.inbox}/${tab.segment}`),
      ...CHANNELS_TABS.map((tab) => `${ROUTES.channels}/${tab.segment}`),
      ...AI_TABS.map((tab) => `${ROUTES.ai}/${tab.segment}`),
      ...DEVELOPERS_TABS.map((tab) => `${ROUTES.developers}/${tab.segment}`),
      ...BRAND_TABS.map((tab) => `${ROUTES.brand}/${tab.segment}`),
      ...ACCOUNT_TABS.map((tab) => tab.path),
      ...helpCenterTabsFor('admin').map((tab) =>
        tab.key === 'articles' ? ROUTES.helpCenter : `${ROUTES.helpCenter}/${tab.key}`,
      ),
    ];

    expect(tabPaths.filter((tab) => !paths.includes(tab))).toEqual([]);
    expect(
      paths.filter((path) => path.startsWith('/settings/') && !tabPaths.includes(path)),
    ).toEqual([
      ROUTES.authentication,
      ROUTES.sso,
      ROUTES.staff,
      ROUTES.system,
      ROUTES.imports,
      ROUTES.systemAuditLog,
    ]);
  });

  it('offers each page to the roles its old tab row did', () => {
    for (const role of ['admin', 'teamLeader', 'agent', 'viewer'] as const) {
      for (const installAdmin of [false, true]) {
        const viewer = { role, installAdmin };
        const offered = pagesFor(viewer).map((page) => page.path);

        for (const tab of AUTOMATION_TABS) {
          expect(offered.includes(`${ROUTES.inbox}/${tab.segment}`)).toBe(
            (tab.roles as readonly string[]).includes(role),
          );
        }
        for (const tab of CHANNELS_TABS) {
          expect(offered.includes(`${ROUTES.channels}/${tab.segment}`)).toBe(
            tab.roles.includes(role),
          );
        }
        for (const tab of AI_TABS) {
          expect(offered.includes(`${ROUTES.ai}/${tab.segment}`)).toBe(
            tab.installAdminOnly ? installAdmin : tab.roles.includes(role),
          );
        }
      }
    }
    for (const role of ['admin', 'teamLeader', 'agent', 'viewer'] as const) {
      const offered = pagesFor({ role, installAdmin: false })
        .filter((page) => page.path.startsWith(ROUTES.helpCenter))
        .map((page) => page.path);
      const expected = helpCenterTabsFor(role).map((tab) =>
        tab.key === 'articles' ? ROUTES.helpCenter : `${ROUTES.helpCenter}/${tab.key}`,
      );
      expect(offered).toEqual(expected);
    }
  });

  it('has unique ids and paths', () => {
    expect(new Set(PAGES.map((page) => page.id)).size).toBe(PAGES.length);
    expect(new Set(paths).size).toBe(PAGES.length);
  });
});

const lookup = (lng: (typeof SUPPORTED_LNGS)[number], key: string): unknown => {
  const [namespace = '', ...path] = key.split(/[:.]/);
  return path.reduce<unknown>(
    (node, part) =>
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined,
    (resources[lng] as Record<string, unknown>)[namespace],
  );
};

describe('the page registry and the catalogs', () => {
  it.each(SUPPORTED_LNGS)('has every title and keyword list in %s', (lng) => {
    const missing = PAGES.flatMap((page) => [
      ...page.title.filter((key) => typeof lookup(lng, key) !== 'string'),
      ...(typeof lookup(lng, `admin:palette.keywords.${page.id}`) === 'string'
        ? []
        : [`admin:palette.keywords.${page.id}`]),
    ]);

    expect(missing).toEqual([]);
  });

  it('has keywords for no page that is gone', () => {
    const ids = new Set(PAGES.map((page) => page.id));
    for (const lng of SUPPORTED_LNGS) {
      const keywords = lookup(lng, 'admin:palette.keywords') as Record<string, string>;
      expect(Object.keys(keywords).filter((id) => !ids.has(id))).toEqual([]);
    }
  });
});

describe('pagesFor', () => {
  const ids = (viewer: Parameters<typeof pagesFor>[0]) => pagesFor(viewer).map((page) => page.id);

  it('offers an agent the work pages and the macros, and no configuration', () => {
    const agent = ids({ role: 'agent', installAdmin: false });

    expect(agent).toEqual(
      expect.arrayContaining([
        'tickets',
        'contacts',
        'helpCenterArticles',
        'automationMacros',
        'accountSecurity',
      ]),
    );
    expect(agent).not.toEqual(expect.arrayContaining(['ticketingSlas']));
    expect(agent).not.toContain('automationRules');
    expect(agent).not.toContain('reports');
    expect(agent).not.toContain('staff');
    expect(agent).not.toContain('settings');
  });

  it('offers a viewer reports and read-only pages, never the macros', () => {
    const viewer = ids({ role: 'viewer', installAdmin: false });

    expect(viewer).toEqual(expect.arrayContaining(['reports', 'helpCenterInsights']));
    expect(viewer).not.toContain('automationMacros');
    expect(viewer).not.toContain('channelsWidget');
  });

  it('offers a team leader the widget but not the mailboxes', () => {
    const leader = ids({ role: 'teamLeader', installAdmin: false });

    expect(leader).toContain('channelsWidget');
    expect(leader).not.toContain('channelsMailboxes');
    expect(leader).toContain('aiKnowledge');
    expect(leader).not.toContain('aiProviders');
  });

  it('offers the install pages to an install admin alone', () => {
    const admin = ids({ role: 'admin', installAdmin: false });
    const installAdmin = ids({ role: 'admin', installAdmin: true });

    expect(admin).not.toEqual(expect.arrayContaining(['settings']));
    expect(admin).not.toContain('system');
    expect(admin).not.toContain('aiProviders');
    expect(installAdmin).toEqual(
      expect.arrayContaining(['settings', 'system', 'systemAuditLog', 'aiProviders']),
    );
  });

  it('offers an admin every brand tab', () => {
    expect(ids({ role: 'admin', installAdmin: false })).toEqual(
      expect.arrayContaining(['brandGeneral', 'brandDomains', 'brandImport', 'brandDanger']),
    );
  });
});

describe('pageAt', () => {
  it('finds a page by its exact path', () => {
    expect(pageAt(ROUTES.systemAuditLog)?.id).toBe('systemAuditLog');
    expect(pageAt('/nowhere')).toBeUndefined();
  });
});
