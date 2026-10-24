import { describe, expect, it } from 'vitest';
import { renderTestEmail } from './test-email.js';

const input = (locale: 'en' | 'ar' = 'en') => ({
  locale,
  to: { address: 'lina@helpdock.test', name: 'Lina Haddad' },
  appUrl: 'https://desk.example.com',
  unsubscribe: {
    page: 'https://desk.example.com/unsubscribe/token?lang=en',
    oneClick: 'https://desk.example.com/api/public/unsubscribe/token',
  },
});

describe('renderTestEmail (M14-11)', () => {
  it('says it is a test and sends only to the address it was given', () => {
    const email = renderTestEmail(input());

    expect(email.subject).toBe('Helpdock test email');
    expect(email.to).toEqual({ address: 'lina@helpdock.test', name: 'Lina Haddad' });
    expect(email.text).toContain('You asked for this test.');
    expect(email.text).toContain('https://desk.example.com/me/notifications');
  });

  it('has the footer and the one-click headers of a real notification', () => {
    const email = renderTestEmail(input());

    expect(email.text).toContain('unsubscribe from notification emails:');
    expect(email.headers).toEqual({
      'List-Unsubscribe': '<https://desk.example.com/api/public/unsubscribe/token>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('is right to left and in Arabic for an Arabic recipient', () => {
    const email = renderTestEmail(input('ar'));

    expect(email.subject).toBe('رسالة تجريبية من Helpdock');
    expect(email.html).toContain('dir="rtl"');
    expect(email.html).toContain('lang="ar"');
  });
});
