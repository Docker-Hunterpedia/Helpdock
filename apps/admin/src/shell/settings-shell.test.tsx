import type { Session } from '@helpdock/schemas';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/routes.tsx';
import type { MockAuthApi } from '../auth/mock-api.js';
import type { AdminApis } from '../auth/select-api.js';
import { renderApp } from '../test/render.tsx';
import { settingsLink, settingsLinks } from '../test/settings-nav.js';
import { signedInMockApis } from '../test/signed-in.js';

/**
 * `Admin/Settings-Shell` (M14-21): the grouped navigation each role gets, the
 * breadcrumb and title the shell gives a page, and the old addresses landing in
 * it. Every page keeps its own content, which its own tests cover.
 */

function Where(): null {
  const { pathname, search, hash } = useLocation();
  document.body.dataset.where = `${pathname}${search}${hash}`;
  return null;
}
const where = (): string => document.body.dataset.where ?? '';

afterEach(() => {
  delete document.body.dataset.where;
  localStorage.clear();
});

const asUser = async (changes: Partial<Session['user']>): Promise<AdminApis> => {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) {
    throw new Error('expected a session');
  }
  const changed: Session = { ...session, user: { ...session.user, ...changes } };
  (apis.auth as MockAuthApi).me = async () => changed;
  return apis;
};

const open = async (path: string, who: Partial<Session['user']> = {}) => {
  const apis = await asUser(who);
  const rendered = renderApp(
    <>
      <Where />
      <AppRoutes />
    </>,
    {
      authApi: apis.auth,
      staffApi: apis.staff,
      ticketingApi: apis.ticketing,
      initialEntries: [path],
    },
  );
  await screen.findByRole('navigation', { name: 'Settings' }, { timeout: 10_000 });
  return rendered;
};

const groupLinks = (group: string): string[] =>
  within(screen.getByRole('list', { name: group }))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');

describe('the groups', () => {
  it('draws every group an install admin has, with the pages of each in order', async () => {
    await open('/settings/inbox/slas');

    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const groupName = (list: HTMLElement): string | undefined =>
      document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent;
    expect(within(nav).getAllByRole('list').map(groupName)).toEqual([
      'Your account',
      'Brand',
      'Inbox',
      'Channels',
      'AI',
      'Developers',
      'Install',
    ]);
    expect(groupLinks('Your account')).toEqual([
      'Profile',
      'Notifications',
      'Security',
      'Email signature',
    ]);
    expect(groupLinks('Brand')).toEqual(['General', 'Domains', 'Danger zone']);
    expect(groupLinks('Inbox')).toEqual([
      'Departments',
      'Statuses',
      'Priorities',
      'Tags',
      'Custom fields',
      'Templates',
      'Views',
      'Assignment',
      'Business hours',
      'SLA policies',
      'Spam',
      'Feedback',
      'Rules',
      'Time-based',
      'Macros',
      'Routing',
    ]);
    expect(groupLinks('Channels')).toEqual([
      'Email',
      'Outgoing email',
      'Telegram',
      'WhatsApp, Messenger, Instagram',
      'Chat widget',
      'Web form',
    ]);
    expect(groupLinks('AI')).toEqual(['Providers', 'Knowledge', 'Assistant']);
    expect(groupLinks('Developers')).toEqual(['API keys', 'Webhooks']);
    expect(groupLinks('Install')).toEqual([
      'Authentication',
      'Single sign-on',
      'Staff and roles',
      'System',
      'Imports',
    ]);
  });

  it('hides what the person’s role cannot open, as the old pages did', async () => {
    await open('/settings/account/profile', { role: 'teamLeader', installAdmin: false });

    expect(screen.queryByRole('list', { name: 'Brand' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Developers' })).toBeNull();
    expect(groupLinks('Channels')).toEqual(['Chat widget']);
    expect(groupLinks('AI')).toEqual(['Knowledge', 'Assistant']);
    expect(groupLinks('Install')).toEqual(['Staff and roles']);
    expect(settingsLinks()).not.toContain('System');
  });

  it('gives an agent their account and the macros', async () => {
    await open('/settings/account/profile', { role: 'agent', installAdmin: false });

    expect(settingsLinks()).toEqual([
      'Profile',
      'Notifications',
      'Security',
      'Email signature',
      'Macros',
    ]);
  });

  it('gives a viewer their account alone', async () => {
    await open('/settings/account/profile', { role: 'viewer', installAdmin: false });

    expect(settingsLinks()).toEqual(['Profile', 'Notifications', 'Security', 'Email signature']);
  });
});

describe('the page header', () => {
  it('gives the page a breadcrumb and the entry’s name as its one h1', async () => {
    await open('/settings/inbox/slas');

    expect(await screen.findByRole('heading', { level: 1, name: 'SLA policies' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(within(crumbs).getByText('Inbox')).toHaveAttribute('aria-current', 'page');
    expect(settingsLink('SLA policies')).toHaveAttribute('aria-current', 'page');
    expect(
      within(screen.getByRole('navigation', { name: 'Settings' })).getAllByRole('link', {
        current: 'page',
      }),
    ).toHaveLength(1);
  });

  it('keeps a deeper page’s own title under its entry’s breadcrumb', async () => {
    await open('/settings/channels/mailboxes/new');

    expect(
      within(await screen.findByRole('navigation', { name: 'Breadcrumb' })).getByText('Channels'),
    ).toHaveAttribute('aria-current', 'page');
    expect(settingsLink('Email')).toHaveAttribute('aria-current', 'page');
  });
});

describe('the way in', () => {
  it('opens the first page the person has from /settings', async () => {
    await open('/settings', { role: 'agent', installAdmin: false });

    await waitFor(() => {
      expect(where()).toBe('/settings/account/profile');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  });

  it.each([
    ['/admin/ticketing/slas?x=1#top', '/settings/inbox/slas?x=1#top', 'SLA policies'],
    ['/admin/ticketing', '/settings/inbox/departments', 'Departments'],
    ['/admin/automation/macros', '/settings/inbox/macros', 'Macros'],
    ['/admin/brand/danger', '/settings/brand/danger', 'Danger zone'],
    ['/admin/brand/import', '/settings/install/imports', 'Imports'],
    ['/admin/channels/widget', '/settings/channels/widget', 'Chat widget'],
    ['/admin/ai/knowledge', '/settings/ai/knowledge', 'Knowledge'],
    ['/admin/developers/webhooks', '/settings/developers/webhooks', 'Webhooks'],
    ['/admin/settings?tab=sso', '/settings/install/sso', 'Single sign-on'],
    ['/admin/staff', '/settings/install/staff', 'Staff and roles'],
    ['/admin/system', '/settings/install/system', 'System'],
    ['/me/security', '/settings/account/security', 'Security'],
  ])('sends the old address %s to %s', async (oldPath, newPath, title) => {
    await open(oldPath);

    await waitFor(() => {
      expect(where()).toBe(newPath);
    });
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeVisible();
  });

  it('sends an agent’s old Automation address to the macros they have', async () => {
    await open('/admin/automation', { role: 'agent', installAdmin: false });

    await waitFor(() => {
      expect(where()).toBe('/settings/inbox/macros');
    });
  });

  it('sends a segment nobody has to the first Inbox page the person is offered', async () => {
    await open('/settings/inbox/nonsense');

    await waitFor(() => {
      expect(where()).toBe('/settings/inbox/departments');
    });
  });
});

describe('dialogs opened from a settings page', () => {
  it('keep the theme’s own widths: a maxWidth="md" dialog is at most 900 px wide', async () => {
    const { user } = await open('/settings/ai/knowledge');

    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    await screen.findByRole('dialog');

    const css = [...document.querySelectorAll('style')].map((tag) => tag.textContent).join('\n');
    // md is 900 px, so its small-screen rule is 964; a shifted theme would say 1184.
    expect(css).not.toContain('1184px');
    expect(css).not.toContain('1120px');
    const paper = document.querySelector('.MuiDialog-paper');
    expect(paper).not.toBeNull();
    expect(Number.parseInt(getComputedStyle(paper as Element).maxWidth, 10)).toBeLessThanOrEqual(
      900,
    );
  });
});
