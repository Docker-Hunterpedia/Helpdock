import { matchPath } from 'react-router';
import { describe, expect, it } from 'vitest';
import { CSAT_PREVIEW_TOKEN } from '../csat/preview-api.js';
import { AI_TABS } from '../screens/admin/ai/tabs.js';
import { AUTOMATION_TABS } from '../screens/admin/automation/tabs.js';
import { CHANNELS_TABS } from '../screens/admin/channels/tabs.js';
import { TICKETING_TABS } from '../screens/admin/ticketing/tabs.js';
import {
  csatPreviewRoute,
  csatTokenFromPath,
  DEFAULT_SIGNED_IN_ROUTE,
  LEGACY_REDIRECTS,
  legacyRedirect,
  magicLinkTokenFromHash,
  ROUTES,
  safeReturnTo,
  ticketIdFromPath,
  ticketRoute,
  unsubscribeTokenFromPath,
} from './route-paths.js';

describe('safeReturnTo', () => {
  it('keeps a path inside the app', () => {
    expect(safeReturnTo('/settings/install/authentication?tab=email')).toBe(
      '/settings/install/authentication?tab=email',
    );
  });

  it.each([
    ['nothing', null],
    ['an empty value', ''],
    ['an absolute url', 'https://evil.example/steal'],
    ['a protocol-relative url', '//evil.example'],
    ['a relative path', 'admin/settings'],
    ['a backslash authority', '/\\evil.example'],
    ['an encoded authority', '/%2f%2fevil.example'],
    ['an encoded backslash', '/%5cevil.example'],
    ['a control character', '/tickets\n'],
  ])('falls back to the default screen for %s', (_case, value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_SIGNED_IN_ROUTE);
  });
});

describe('ticketIdFromPath', () => {
  it('is the id the workspace has open', () => {
    expect(ticketIdFromPath('/tickets/0192c3f0')).toBe('0192c3f0');
  });

  it('is null on the list itself', () => {
    expect(ticketIdFromPath('/tickets')).toBeNull();
    expect(ticketIdFromPath('/tickets/')).toBeNull();
  });

  it('is null anywhere else in the app', () => {
    expect(ticketIdFromPath('/contacts/0192c3f0')).toBeNull();
  });

  it('decodes what the link encoded', () => {
    expect(ticketIdFromPath(ticketRoute('a/b'))).toBe('a/b');
  });

  it('ignores anything past the id rather than reading it as one', () => {
    expect(ticketIdFromPath('/tickets/0192c3f0/whatever')).toBe('0192c3f0');
  });
});

describe('csatTokenFromPath', () => {
  it('reads the token of a rating link', () => {
    expect(csatTokenFromPath('/csat/AAA.bbb')).toBe('AAA.bbb');
  });

  it.each(['/csat/', '/csat', '/tickets/csat/AAA', '/'])('is null for %s', (path) => {
    expect(csatTokenFromPath(path)).toBeNull();
  });

  it('reads the preview route as the preview token, in the language it names', () => {
    const route = new URL(csatPreviewRoute('ar'), 'https://support.example.com');

    expect(csatTokenFromPath(route.pathname)).toBe(CSAT_PREVIEW_TOKEN);
    expect(route.searchParams.get('lang')).toBe('ar');
  });
});

describe('magicLinkTokenFromHash', () => {
  it('reads the token from the fragment a sign-in link carries', () => {
    expect(magicLinkTokenFromHash('#token=AbC-123_xyz')).toBe('AbC-123_xyz');
  });

  it.each([
    ['no fragment', ''],
    ['an empty fragment', '#'],
    ['a fragment without a token', '#other=1'],
  ])('is empty for %s', (_case, hash) => {
    expect(magicLinkTokenFromHash(hash)).toBe('');
  });
});

describe('unsubscribeTokenFromPath', () => {
  it('reads the token of the unsubscribe page', () => {
    expect(unsubscribeTokenFromPath('/unsubscribe/AAA.bbb')).toBe('AAA.bbb');
  });

  it.each(['/unsubscribe/', '/unsubscribe', '/me/unsubscribe/AAA', '/csat/AAA', '/'])(
    'is null for %s',
    (path) => {
      expect(unsubscribeTokenFromPath(path)).toBeNull();
    },
  );
});

/**
 * M14-21: every address the admin had before the Settings area, with where it
 * lives now. A bookmark, a guide, an email the api already sent and the setup
 * checklist all hold these.
 */
const RUN = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';
const OLD_ADDRESSES: readonly (readonly [string, string])[] = [
  ['/me', '/settings/account/profile'],
  ['/me/profile', '/settings/account/profile'],
  ['/me/security', '/settings/account/security'],
  ['/me/notifications', '/settings/account/notifications'],
  ['/me/signature', '/settings/account/signature'],
  ['/me/security?connected=github', '/settings/account/security?connected=github'],

  ['/admin/settings', '/settings/install/authentication'],
  ['/admin/settings?tab=authentication', '/settings/install/authentication'],
  ['/admin/settings?tab=sso', '/settings/install/sso'],
  ['/admin/settings?tab=sso&filter=okta', '/settings/install/sso?filter=okta'],
  ['/admin/settings/sso/abc', '/settings/install/sso/abc'],
  ['/admin/settings/sso/abc?test=token', '/settings/install/sso/abc?test=token'],

  ['/admin/ticketing', '/settings/inbox/departments'],
  ...TICKETING_TABS.map(
    (tab) => [`/admin/ticketing/${tab.segment}`, `/settings/inbox/${tab.segment}`] as const,
  ),
  ['/admin/ticketing/views?x=1#top', '/settings/inbox/views?x=1#top'],

  ['/admin/automation', '/settings/inbox/rules'],
  ...AUTOMATION_TABS.map(
    (tab) => [`/admin/automation/${tab.segment}`, `/settings/inbox/${tab.segment}`] as const,
  ),
  ['/admin/automation/rules/new?kind=scheduled', '/settings/inbox/rules/new?kind=scheduled'],
  [`/admin/automation/rules/${RUN}`, `/settings/inbox/rules/${RUN}`],

  ['/admin/brand', '/settings/brand'],
  ['/admin/brand/general', '/settings/brand/general'],
  ['/admin/brand/domains', '/settings/brand/domains'],
  ['/admin/brand/danger', '/settings/brand/danger'],
  ['/admin/brand/import', '/settings/install/imports'],
  [`/admin/brand/import/${RUN}`, `/settings/install/imports/${RUN}`],

  ['/admin/channels', '/settings/channels'],
  ...CHANNELS_TABS.map(
    (tab) => [`/admin/channels/${tab.segment}`, `/settings/channels/${tab.segment}`] as const,
  ),
  ['/admin/channels/mailboxes/new', '/settings/channels/mailboxes/new'],
  [`/admin/channels/mailboxes/${RUN}`, `/settings/channels/mailboxes/${RUN}`],
  [`/admin/channels/telegram/${RUN}`, `/settings/channels/telegram/${RUN}`],
  [`/admin/channels/meta/${RUN}`, `/settings/channels/meta/${RUN}`],

  ['/admin/ai', '/settings/ai'],
  ...AI_TABS.map((tab) => [`/admin/ai/${tab.segment}`, `/settings/ai/${tab.segment}`] as const),
  [
    '/admin/ai/knowledge?source=s1&oauth=connected',
    '/settings/ai/knowledge?source=s1&oauth=connected',
  ],

  ['/admin/developers', '/settings/developers'],
  ['/admin/developers/api-keys', '/settings/developers/api-keys'],
  ['/admin/developers/webhooks', '/settings/developers/webhooks'],

  ['/admin/staff', '/settings/install/staff'],
  ['/admin/system', '/settings/install/system'],
  ['/admin/system/audit-log', '/settings/install/system/audit-log'],
  ['/admin/system/queues', '/settings/install/system/queues'],
];

describe('legacyRedirect', () => {
  it.each(OLD_ADDRESSES)('sends %s to %s', (from, to) => {
    const url = new URL(from, 'https://helpdock.test');

    expect(legacyRedirect(url.pathname, url.search, url.hash)).toBe(to);
  });

  it('sends every address to a route the router has', () => {
    const patterns = Object.values(ROUTES);
    const unknown = OLD_ADDRESSES.map(
      ([, to]) => new URL(to, 'https://helpdock.test').pathname,
    ).filter((path) => !patterns.some((pattern) => matchPath({ path: pattern, end: true }, path)));

    expect(unknown).toEqual([]);
  });

  it('is exercised by an address for every row of the table', () => {
    const firstMatch = (path: string) =>
      LEGACY_REDIRECTS.findIndex(({ from }) => matchPath({ path: from, end: true }, path) !== null);
    const exercised = new Set(
      OLD_ADDRESSES.map(([from]) => firstMatch(new URL(from, 'https://helpdock.test').pathname)),
    );

    expect(LEGACY_REDIRECTS.filter((_row, index) => !exercised.has(index))).toEqual([]);
  });

  it('keeps an id that needs encoding', () => {
    expect(legacyRedirect('/admin/channels/telegram/a b')).toBe(
      '/settings/channels/telegram/a%20b',
    );
    expect(legacyRedirect('/admin/settings/sso/a%2Fb')).toBe('/settings/install/sso/a%2Fb');
  });

  it.each([
    '/tickets',
    '/contacts',
    '/admin',
    '/admin/unknown',
    '/administrator',
    '/settings/inbox/slas',
    '/meeting',
    '/me/security/extra',
  ])('leaves %s alone', (path) => {
    expect(legacyRedirect(path)).toBeNull();
  });
});
