import { fontFallbacks } from '@helpdock/ui/resolve';
import { describe, expect, it } from 'vitest';
import { escapeHtml } from './email-templates.js';
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
    const values = {
      change,
      provider: 'GitHub',
      account: 'lina@users.noreply.github.com',
      passkey: 'MacBook Air',
    };
    const en = notice(values);
    const ar = notice(values, 'ar');

    expect(en.text).toContain(SECURITY_PAGE);
    expect(en.text).toContain('support.example.com');
    expect(`${en.subject}${en.text}`).not.toMatch(/securityChange|\{\{|oauthC|body_/);
    expect(`${ar.subject}${ar.text}`).not.toMatch(/securityChange|\{\{|oauthC|body_/);
    expect(ar.html).toContain('dir="rtl"');
    for (const email of [en, ar]) {
      expect(email.html).toContain(`font-family:${escapeHtml(fontFallbacks.sans)}`);
    }
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

  describe('passkeys (M18-02, Email/SecurityChange-M18)', () => {
    const added = {
      change: 'passkeyAdded',
      passkey: 'MacBook Air · Touch ID',
      occurredAt: OCCURRED_AT,
      browser: 'Chrome',
      os: 'macOS',
      ip: '85.12.x.x',
    };

    it('names the passkey that was added, when, and where from', () => {
      const en = notice(added, 'en', 'Asia/Riyadh');

      expect(en.subject).toBe('A passkey was added to your account');
      expect(en.text).toContain('A passkey was added');
      expect(en.text).toContain('“MacBook Air · Touch ID” can now sign you in to Helpdock.');
      expect(en.text).toContain('When: 21 Oct 2026, 09:14 (Asia/Riyadh)');
      expect(en.text).toContain('From: Chrome on macOS · 85.12.x.x');
      expect(en.text).toContain("If this wasn't you, remove it now and change your password.");
      expect(en.text).toContain(`Review your passkeys: ${SECURITY_PAGE}`);
    });

    it('says it in Arabic, with the name isolated from the sentence', () => {
      const ar = notice(added, 'ar', 'Asia/Riyadh');

      expect(ar.subject).toBe('أُضيف مفتاح مرور إلى حسابك');
      expect(ar.text).toContain('Chrome على macOS · 85.12.x.x');
      expect(ar.html).toContain('<bdi>MacBook Air · Touch ID</bdi>');
    });

    it('leaves the From row out when the request told us nothing', () => {
      const en = notice({ change: 'passkeyAdded', passkey: 'Key', occurredAt: OCCURRED_AT });

      expect(en.text).not.toContain('From:');
    });

    it('escapes a name that carries markup, and keeps it out of the subject’s markup', () => {
      const en = notice({ change: 'passkeyAdded', passkey: '<img src=x onerror=alert(1)>' });

      expect(en.html).not.toContain('<img');
      expect(en.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it.each([
      [{ remaining: '2', totp: '1' }, 'You still have 2 passkeys and an authenticator app.'],
      [{ remaining: '1', totp: '1' }, 'You still have 1 passkey and an authenticator app.'],
      [{ remaining: '1', totp: '0' }, 'You still have 1 passkey.'],
      [{ remaining: '0', totp: '1' }, 'You still have an authenticator app.'],
    ])('tells what still protects the account after a removal: %j', (rest, sentence) => {
      const en = notice({ change: 'passkeyRemoved', passkey: 'YubiKey 5C', ...rest });

      expect(en.subject).toBe('A passkey was removed from your account');
      expect(en.text).toContain(`“YubiKey 5C” can no longer sign you in. ${sentence}`);
      expect(en.text).toContain(`Open your security page: ${SECURITY_PAGE}`);
    });

    it('adds no sentence about what remains when nothing does', () => {
      const en = notice({ change: 'passkeyRemoved', passkey: 'Key', remaining: '0', totp: '0' });

      expect(en.text).toContain('“Key” can no longer sign you in.\n');
      expect(en.text).not.toContain('You still have');
    });

    it('counts the passkeys a reset kept, in both languages, and leaves out the warning', () => {
      const en = notice({ change: 'passwordReset', passkeys: '2' });
      const ar = notice({ change: 'passwordReset', passkeys: '2' }, 'ar');

      expect(en.subject).toBe('Your password was reset');
      expect(en.text).toContain('Your 2 passkeys were kept');
      expect(en.text).toContain(`Review your passkeys: ${SECURITY_PAGE}`);
      expect(en.text).not.toContain("wasn't you");
      expect(en.text).not.toContain('If it was not you');
      expect(ar.text).toContain('أُبقي على مفتاحَي المرور لديك');
    });

    it('uses the plain reset notice when the account holds no passkey', () => {
      const en = notice({ change: 'passwordReset', passkeys: '0' });

      expect(en.text).toContain('If it was not you, reset your password now');
      expect(en.text).not.toContain('passkey');
    });
  });

  it('refuses a change it has no sentence for, rather than sending a blank one', () => {
    expect(() => notice({ change: 'somethingElse' })).toThrow(TypeError);
  });
});
