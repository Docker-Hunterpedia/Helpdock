import { describe, expect, it } from 'vitest';
import { renderSignInEmail } from './sign-in-email.js';

const URL_TO_OPEN = 'https://help.acme.test/sign-in/confirm?token=abc&lang=en';

describe('renderSignInEmail', () => {
  it('writes the English message of Email/Portal-SignIn, in both parts, with the link', () => {
    const message = renderSignInEmail({
      locale: 'en',
      brandName: 'Helpdock',
      address: 'mona@acme.example',
      url: URL_TO_OPEN,
    });

    expect(message.subject).toBe('Your sign-in link for Helpdock Help');
    expect(message.text).toContain(
      'Someone asked to sign in to Helpdock Help with mona@acme.example. If it was you, use this link within 15 minutes:',
    );
    expect(message.text).toContain(URL_TO_OPEN);
    expect(message.text).toContain(
      'The link works once. If you did not ask for it, ignore this email',
    );
    expect(message.html).toContain('dir="ltr"');
    expect(message.html).toContain(`href="${URL_TO_OPEN.replaceAll('&', '&amp;')}"`);
    expect(message.html).toContain('Sign in to see your tickets');
    expect(message.html).toContain(
      '<bdi dir="ltr" style="font-weight:600">mona@acme.example</bdi>',
    );
    expect(message.locale).toBe('en');
  });

  it('writes the Arabic message right to left', () => {
    const message = renderSignInEmail({
      locale: 'ar',
      brandName: 'Helpdock',
      address: 'mona@acme.example',
      url: URL_TO_OPEN,
    });

    expect(message.subject).toBe('رابط دخولك إلى مساعدة Helpdock');
    expect(message.html).toContain('dir="rtl"');
    expect(message.html).toContain('lang="ar"');
    expect(message.html).toContain('سجّل الدخول لترى تذاكرك');
    expect(message.text).toContain('خلال 15 دقيقة');
  });

  it('escapes a brand name and carries nothing about any ticket', () => {
    const message = renderSignInEmail({
      locale: 'en',
      brandName: '<img src=x onerror=1>',
      address: 'mona@acme.example',
      url: URL_TO_OPEN,
    });

    expect(message.html).not.toContain('<img src=x');
    expect(message.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(message.text.toLowerCase()).not.toContain('ticket #');
  });
});
