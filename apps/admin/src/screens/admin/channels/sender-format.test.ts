import { describe, expect, it } from 'vitest';
import { formatSender, parseReplyTo, parseSender } from './sender-format.js';

describe('formatSender', () => {
  it('writes a named sender the way a mail client shows it', () => {
    expect(formatSender({ name: 'Helpdock Billing', address: 'billing@helpdock.io' })).toBe(
      'Helpdock Billing <billing@helpdock.io>',
    );
  });

  it('writes a bare address, and nothing for no sender', () => {
    expect(formatSender({ name: '', address: 'billing@helpdock.io' })).toBe('billing@helpdock.io');
    expect(formatSender(null)).toBe('');
  });
});

describe('parseSender', () => {
  it('reads a name and an address, quotes or not', () => {
    expect(parseSender('  "Helpdock Billing" < billing@helpdock.io > ')).toEqual({
      name: 'Helpdock Billing',
      address: 'billing@helpdock.io',
    });
  });

  it('reads a bare address as a sender with no name', () => {
    expect(parseSender('billing@helpdock.io')).toEqual({
      name: '',
      address: 'billing@helpdock.io',
    });
  });

  it('refuses what is not an address', () => {
    expect(parseSender('Billing')).toBeNull();
    expect(parseSender('Billing <not an address>')).toBeNull();
    expect(parseSender('')).toBeNull();
  });
});

describe('parseReplyTo', () => {
  it('reads empty as none and refuses anything else that is not an address', () => {
    expect(parseReplyTo(' ')).toEqual({ ok: true, value: null });
    expect(parseReplyTo('refunds@helpdock.io')).toEqual({ ok: true, value: 'refunds@helpdock.io' });
    expect(parseReplyTo('refunds')).toEqual({ ok: false });
  });
});
