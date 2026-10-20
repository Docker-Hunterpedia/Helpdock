import { describe, expect, it } from 'vitest';
import { renderSecurityNoticeEmail, SECURITY_CHANGES } from './security-notice-email.js';

const SECURITY_PAGE = 'https://support.example.com/me/security';
const OCCURRED_AT = '2026-10-21T06:14:00.000Z';

const notice = (
  values: Record<string, string>,
  locale: 'en' | 'ar' = 'en',
  timeZone: string | undefined = undefined,
) =>
  renderSecurityNoticeEmail({
    to: 'lina@helpdock.com',
    url: SECURITY_PAGE,
    locale,
    values,
    ...(timeZone === undefined ? {} : { timeZone }),
  });

describe('the security notice (ASVS 2.2.3, Email/SecurityChange-M18)', () => {
  it.each(SECURITY_CHANGES)('words every change in both languages: %s', (change) => {
    const values = { change, provider: 'GitHub', account: 'lina@users.noreply.github.com' };
    const en = notice(values);
    const ar = notice(values, 'ar');

    expect(en.text).toContain(SECURITY_PAGE);
    expect(en.text).toContain('support.example.com');
    expect(`${en.subject}${en.text}`).not.toMatch(/securityChange|\{\{|oauthC|body_/);
    expect(`${ar.subject}${ar.text}`).not.toMatch(/securityChange|\{\{|oauthC|body_/);
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).not.toBe(en.text);
  });

  it('names the provider and the provider account that was connected', () => {
    const connected = notice({
      change: 'oauthConnected',
      provider: 'GitHub',
      account: 'lina@users.noreply.github.com',
    });

    expect(connected.subject).toBe('GitHub was connected to your account');
    expect(connected.text).toContain('You can now sign in with GitHub');
    expect(connected.text).toContain(
      'The GitHub account lina@users.noreply.github.com is connected.',
    );
    expect(connected.text).toContain("If this wasn't you, disconnect it and change your password.");
    expect(connected.text).toContain(`Review sign-in methods: ${SECURITY_PAGE}`);
  });

  it('says a disconnected provider can no longer sign in', () => {
    const disconnected = notice({
      change: 'oauthDisconnected',
      provider: 'Google',
      account: 'lina@helpdock.com',
    });

    expect(disconnected.subject).toBe('Google was disconnected from your account');
    expect(disconnected.text).toContain('You can no longer sign in with Google');
  });

  it('keeps the generic wording for a change without its own block', () => {
    const password = notice({ change: 'password' });

    expect(password.subject).toBe('Your Helpdock sign-in details changed');
    expect(password.text).toContain(
      'If it was not you, reset your password now and tell your administrator.',
    );
  });

  it('says when, in the zone it is given, and leaves the row out without a time', () => {
    const riyadh = notice({ change: 'password', occurredAt: OCCURRED_AT }, 'en', 'Asia/Riyadh');

    expect(riyadh.text).toContain('When: 21 Oct 2026, 09:14 (Asia/Riyadh)');
    expect(notice({ change: 'password', occurredAt: OCCURRED_AT }).text).toContain(
      'When: 21 Oct 2026, 06:14 (UTC)',
    );
    expect(notice({ change: 'password' }).text).not.toContain('When:');
  });

  it('isolates addresses inside an Arabic sentence and escapes them', () => {
    const ar = notice(
      { change: 'oauthConnected', provider: 'Google', account: 'a<b>@example.com' },
      'ar',
    );

    expect(ar.html).toContain('<bdi dir="ltr">a&lt;b&gt;@example.com</bdi>');
    expect(ar.html).not.toContain('<b>');
  });

  it('wraps an account address that contains the recipient’s once, whole', () => {
    const en = notice({
      change: 'oauthConnected',
      provider: 'GitHub',
      account: 'x.lina@helpdock.com',
    });

    expect(en.html).toContain('<bdi dir="ltr">x.lina@helpdock.com</bdi> is connected');
    expect(en.html).not.toContain('<bdi dir="ltr"><bdi');
  });

  it('refuses a change it has no sentence for, rather than sending a blank one', () => {
    expect(() => notice({ change: 'somethingElse' })).toThrow(TypeError);
  });
});
