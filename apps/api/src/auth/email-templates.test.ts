import { describe, expect, it } from 'vitest';
import { escapeHtml, renderAuthEmail } from './email-templates.js';

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
      ttlMinutes: 10,
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
      ttlMinutes: 10,
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
      ttlMinutes: 1,
    });

    expect(message.text).toContain('The link expires in 1 minute.');
  });

  it('words the password reset as a reset and not as a sign-in', () => {
    const message = renderAuthEmail({
      kind: 'passwordReset',
      to: 'lina@helpdock.com',
      url: URL_WITH_TOKEN,
      locale: 'en',
      ttlMinutes: 10,
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
      ttlMinutes: 10,
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
      ttlMinutes: 10,
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
      ttlMinutes: 10,
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
        ttlMinutes: 10,
      });

      expect(message.text).not.toContain('passwordReset.');
      expect(message.subject).not.toContain('.subject');
    }
  });
});
