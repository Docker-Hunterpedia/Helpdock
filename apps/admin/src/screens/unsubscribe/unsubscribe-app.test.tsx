import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type UnsubscribeApi, UnsubscribeLinkError } from '../../unsubscribe/api.js';
import {
  MOCK_UNSUBSCRIBE_EMAIL,
  MOCK_UNSUBSCRIBE_TOKENS,
  MockUnsubscribeApi,
} from '../../unsubscribe/mock-api.js';
import { UnsubscribeApp } from './unsubscribe-app.tsx';

/**
 * The public unsubscribe page against its fixture (`Public/Unsubscribe`, en and
 * ar): the confirmation that changes nothing until it is pressed, what is left
 * afterwards, and one screen for every link that is no good.
 */

const renderPage = (token: string, options: { search?: string; api?: UnsubscribeApi } = {}) => {
  const user = userEvent.setup();
  const api = options.api ?? new MockUnsubscribeApi();
  render(<UnsubscribeApp token={token} search={options.search ?? ''} api={api} />);

  return { user, api };
};

describe('a valid link', () => {
  it('asks first, naming the address and what keeps working, and posts nothing on load', async () => {
    const { api } = renderPage(MOCK_UNSUBSCRIBE_TOKENS.valid);

    expect(await screen.findByRole('heading', { name: 'Stop notification emails?' })).toBeVisible();
    expect(screen.getByText(MOCK_UNSUBSCRIBE_EMAIL)).toBeVisible();
    expect(screen.getByText(/The bell in Helpdock and security emails keep working/)).toBeVisible();
    expect((api as MockUnsubscribeApi).posts).toBe(0);
  });

  it('unsubscribes on the button and says what still reaches the person', async () => {
    const { user, api } = renderPage(MOCK_UNSUBSCRIBE_TOKENS.valid);

    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      "You're unsubscribed from notification emails.",
    );
    expect(screen.getByText(/the bell in Helpdock, push notifications/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open notification settings' })).toHaveAttribute(
      'href',
      '/settings/account/notifications',
    );
    expect((api as MockUnsubscribeApi).posts).toBe(1);
  });

  it('keeps the button and says nothing changed when the unsubscribe fails', async () => {
    const api: UnsubscribeApi = {
      view: async () => ({ state: 'confirm', email: 'lina@helpdock.com', locale: 'en' }),
      unsubscribe: () => Promise.reject(new UnsubscribeLinkError('unavailable')),
    };
    const { user } = renderPage(MOCK_UNSUBSCRIBE_TOKENS.valid, { api });

    await user.click(await screen.findByRole('button', { name: 'Unsubscribe' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was changed.');
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeEnabled();
  });
});

describe('a link that is no good', () => {
  it.each([
    ['expired', MOCK_UNSUBSCRIBE_TOKENS.expired],
    ['made up', `${'Z'.repeat(27)}.${'Z'.repeat(43)}`],
  ])('draws one screen for a %s token, naming no address', async (_name, token) => {
    renderPage(token);

    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
    expect(screen.queryByText(MOCK_UNSUBSCRIBE_EMAIL)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
  });

  it('says it could not reach Helpdock, and tries again on request', async () => {
    let attempts = 0;
    const api: UnsubscribeApi = {
      view: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new UnsubscribeLinkError('unavailable');
        }
        return { state: 'confirm', email: 'lina@helpdock.com', locale: 'en' };
      },
      unsubscribe: async () => ({ state: 'done', locale: 'en' }),
    };
    const { user } = renderPage(MOCK_UNSUBSCRIBE_TOKENS.valid, { api });

    expect(await screen.findByRole('heading', { name: 'Could not reach Helpdock' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Stop notification emails?' })).toBeVisible();
  });
});

describe('the page’s language', () => {
  it('is the account’s once the link is known, right to left in Arabic', async () => {
    renderPage(MOCK_UNSUBSCRIBE_TOKENS.arabic);

    expect(await screen.findByRole('heading', { name: 'إيقاف رسائل الإشعارات؟' })).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('button', { name: 'إلغاء الاشتراك' })).toBeVisible();
  });

  it('is ?lang= for a link that is no good, which the email’s link carries', async () => {
    renderPage(MOCK_UNSUBSCRIBE_TOKENS.expired, { search: '?lang=ar' });

    expect(await screen.findByRole('heading', { name: 'انتهت صلاحية هذا الرابط' })).toBeVisible();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });
});
