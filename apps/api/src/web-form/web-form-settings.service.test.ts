import { describe, expect, it } from 'vitest';
import { defaultThankYou, publicFormUrl } from './web-form-settings.service.js';

describe('publicFormUrl', () => {
  it('is `/contact` on the verified help center host', () => {
    expect(publicFormUrl('https://desk.example.com', 'b-1', 'help.acme.com')).toBe(
      'https://help.acme.com/contact',
    );
  });

  it('is `/contact/<brandId>` on the install until the brand has a host', () => {
    expect(publicFormUrl('https://desk.example.com/', 'b-1', undefined)).toBe(
      'https://desk.example.com/contact/b-1',
    );
  });
});

describe('defaultThankYou', () => {
  it('keeps the placeholder for the reference, in both languages', () => {
    expect(defaultThankYou('en')).toContain('{{ticket.number}}');
    expect(defaultThankYou('ar')).toContain('{{ticket.number}}');
    expect(defaultThankYou('ar')).not.toBe(defaultThankYou('en'));
  });
});
