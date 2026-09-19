import { describe, expect, it } from 'vitest';
import { renderSmtpTestEmail } from './setup-email.js';

describe('renderSmtpTestEmail', () => {
  it('addresses the admin and names the relay it went through', () => {
    const message = renderSmtpTestEmail({
      to: 'lina@example.com',
      name: 'Lina',
      host: 'smtp.example.com',
      locale: 'en',
    });

    expect(message.to).toEqual({ address: 'lina@example.com', name: 'Lina' });
    expect(message.subject).toBe('Helpdock test message');
    expect(message.text).toContain('smtp.example.com');
    expect(message.html).toContain('smtp.example.com');
  });

  it('renders Arabic right to left, because a mirrored message is a broken one', () => {
    const message = renderSmtpTestEmail({
      to: 'lina@example.com',
      name: 'Lina',
      host: 'smtp.example.com',
      locale: 'ar',
    });

    expect(message.locale).toBe('ar');
    expect(message.html).toContain('lang="ar"');
    expect(message.html).toContain('dir="rtl"');
    expect(message.subject).not.toBe('Helpdock test message');
  });

  it('escapes a hostname that carries markup, so a field cannot become an element', () => {
    const message = renderSmtpTestEmail({
      to: 'lina@example.com',
      name: 'Lina',
      host: '<script>alert(1)</script>',
      locale: 'en',
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('carries a plain-text body, for a client that refuses HTML', () => {
    const message = renderSmtpTestEmail({
      to: 'lina@example.com',
      name: 'Lina',
      host: 'smtp.example.com',
      locale: 'en',
    });

    expect(message.text).not.toContain('<');
    expect(message.text.trim().length).toBeGreaterThan(0);
  });
});
