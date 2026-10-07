import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAuthEmail, SECURITY_CHANGES } from './email-templates.js';

const URL_WITH_TOKEN = 'https://support.example.com/api/auth/magic-link/abc-123?a=1&b=2';

describe('escapeHtml', () => {
  it('neutralises every character that could open a tag or close an attribute', () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;',
    );
  });
});

describe('renderAuthEmail', () => {
  it('renders the English magic link from the catalog', () => {
    const message = renderAuthEmail({
      kind: 'magicLink',
      to: 'lina@helpdock.com',
      name: 'Lina',
      url: URL_WITH_TOKEN,
      locale: 'en',
      expiresIn: 10,
    });

    expect(message.subject).toBe('Your sign-in link for Helpdock');
    expect(message.text).toContain('The link expires in 10 minutes.');
    expect(message.to).toEqual({ address: 'lina@helpdock.com', name: 'Lina' });
  });

  it('renders the Arabic one right to left, with no English left in it', () => {
    const message = renderAuthEmail({
      kind: 'magicLink',
      to: 'lina@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'ar',
      expiresIn: 10,
    });

    expect(message.html).toContain('dir="rtl"');
    expect(message.html).toContain('lang="ar"');
    expect(message.subject).toContain('رابط الدخول');
  });

  it('uses the singular form when the link lasts one minute', () => {
    const message = renderAuthEmail({
      kind: 'magicLink',
      to: 'lina@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'en',
      expiresIn: 1,
    });

    expect(message.text).toContain('The link expires in 1 minute.');
  });

  it('words the password reset as a reset and not as a sign-in', () => {
    const message = renderAuthEmail({
      kind: 'passwordReset',
      to: 'lina@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'en',
      expiresIn: 10,
    });

    expect(message.subject).toBe('Reset your Helpdock password');
    expect(message.text).toContain('Choose a new password');
  });

  it('always carries a plain-text body, for a client that will not render HTML', () => {
    const message = renderAuthEmail({
      kind: 'magicLink',
      to: 'lina@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'en',
      expiresIn: 10,
    });

    expect(message.text).toContain(URL_WITH_TOKEN);
    expect(message.text).not.toContain('<');
  });

  it('escapes the link in the markup, so a query string cannot close the attribute', () => {
    const message = renderAuthEmail({
      kind: 'magicLink',
      to: 'lina@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'en',
      expiresIn: 10,
    });

    expect(message.html).toContain('?a=1&amp;b=2');
    expect(message.html).not.toContain('?a=1&b=2');
  });

  it('never interpolates the address into the markup unescaped', () => {
    const message = renderAuthEmail({
      kind: 'magicLink',
      to: 'a"><script>alert(1)</script>@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'en',
      expiresIn: 10,
    });

    expect(message.html).not.toContain('<script>');
  });

  it('leaves no untranslated key behind in either language', () => {
    for (const locale of ['en', 'ar'] as const) {
      const message = renderAuthEmail({
        kind: 'passwordReset',
        to: 'lina@helpdock.com',
        url: URL_WITH_TOKEN,
        locale,
        expiresIn: 10,
      });

      expect(message.text).not.toContain('passwordReset.');
      expect(message.subject).not.toContain('.subject');
    }
  });
});

describe('the security notice (ASVS 2.2.3)', () => {
  const notice = (change: string, locale: 'en' | 'ar' = 'en') =>
    renderAuthEmail({
      kind: 'securityChange',
      to: 'lina@helpdock.com',
      url: 'https://support.example.com/me/security',
      locale,
      values: { change },
    });

  it.each(SECURITY_CHANGES)('says which credential changed: %s', (change) => {
    const en = notice(change);
    const ar = notice(change, 'ar');

    expect(en.subject).toBe('Your Helpdock sign-in details changed');
    expect(en.text).toContain('lina@helpdock.com');
    expect(en.text).toContain('https://support.example.com/me/security');
    expect(en.text).not.toContain('expires');
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).not.toBe(en.text);
  });

  it('tells a person who did not make the change what to do', () => {
    expect(notice('password').text).toContain(
      'If it was not you, reset your password now and tell your administrator.',
    );
  });

  it('refuses a change it has no sentence for, rather than sending a blank one', () => {
    expect(() => notice('somethingElse')).toThrow(TypeError);
  });
});
