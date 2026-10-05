import { describe, expect, it } from 'vitest';
import {
  PiiRedactor,
  passesIbanChecksum,
  passesLuhn,
  redactPii,
  restorePii,
  toAsciiDigits,
} from './pii.js';

describe('email addresses', () => {
  it('are replaced with a numbered placeholder', () => {
    const result = redactPii('Write to mona.khalil+orders@example.co.uk please');

    expect(result.text).toBe('Write to [EMAIL_1] please');
    expect(result.redactions).toEqual([
      { placeholder: '[EMAIL_1]', kind: 'email', original: 'mona.khalil+orders@example.co.uk' },
    ]);
  });

  it('get one placeholder per distinct address, reused for repeats', () => {
    const result = redactPii('a@example.com, b@example.com, a@example.com');

    expect(result.text).toBe('[EMAIL_1], [EMAIL_2], [EMAIL_1]');
  });
});

describe('phone numbers', () => {
  it.each([
    ['+49 30 1234 5678', 'international with spaces'],
    ['+1 (415) 555-0100', 'international with brackets and a hyphen'],
    ['00966501234567', 'international with a 00 prefix'],
    ['0501234567', 'local with a trunk 0'],
    ['079.123.45.67', 'local with dots'],
  ])('redacts %s (%s)', (phone) => {
    expect(redactPii(`Call me on ${phone} today`).text).toBe('Call me on [PHONE_1] today');
  });

  it('redacts a number typed in Arabic-Indic digits', () => {
    const result = redactPii('رقمي ٠٥٠١٢٣٤٥٦٧ شكرا');

    expect(result.text).toBe('رقمي [PHONE_1] شكرا');
    expect(result.redactions[0]?.original).toBe('٠٥٠١٢٣٤٥٦٧');
  });

  it('redacts a number typed in Extended Arabic-Indic digits with a plus', () => {
    expect(redactPii('+۹۶۶ ۵۰ ۱۲۳ ۴۵۶۷').text).toBe('[PHONE_1]');
  });

  it.each([
    ['Order 12345678 is late', 'an order number'],
    ['It was 2026-10-05 at noon', 'a date'],
    ['Ticket HD-1042', 'a ticket reference'],
  ])('leaves %s alone (%s)', (text) => {
    expect(redactPii(text).text).toBe(text);
  });
});

describe('payment cards', () => {
  it('redacts a number that passes Luhn, spaced or run together', () => {
    expect(redactPii('Card 4111 1111 1111 1111 expires').text).toBe('Card [CARD_1] expires');
    expect(redactPii('Card 5500-0000-0000-0004').text).toBe('Card [CARD_1]');
    expect(redactPii('378282246310005').text).toBe('[CARD_1]');
  });

  it('redacts a card typed in Arabic-Indic digits', () => {
    expect(redactPii('البطاقة ٤١١١١١١١١١١١١١١١').text).toBe('البطاقة [CARD_1]');
  });

  it('leaves a 16-digit number that fails Luhn, which is more likely a tracking code', () => {
    expect(redactPii('Tracking 4111111111111112').text).toBe('Tracking 4111111111111112');
  });

  it('checks Luhn', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(passesLuhn('')).toBe(false);
  });
});

describe('IBANs', () => {
  it('redacts a valid IBAN, grouped or run together', () => {
    expect(redactPii('Pay DE89 3704 0044 0532 0130 00 now').text).toBe('Pay [IBAN_1] now');
    expect(redactPii('IBAN GB82WEST12345698765432.').text).toBe('IBAN [IBAN_1].');
    expect(redactPii('SA03 8000 0000 6080 1016 7519').text).toBe('[IBAN_1]');
  });

  it('does not swallow the word after it', () => {
    expect(redactPii('DE89 3704 0044 0532 0130 00 thanks').text).toBe('[IBAN_1] thanks');
  });

  it('leaves an IBAN-shaped string that fails mod-97', () => {
    expect(redactPii('DE89 3704 0044 0532 0130 01').text).not.toContain('[IBAN_1]');
  });

  it('checks mod-97', () => {
    expect(passesIbanChecksum('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(passesIbanChecksum('GB83WEST12345698765432')).toBe(false);
    expect(passesIbanChecksum('not an iban')).toBe(false);
  });
});

describe('a redaction session', () => {
  it('numbers placeholders across every text it redacts', () => {
    const redactor = new PiiRedactor();

    const first = redactor.redact('From a@example.com');
    const second = redactor.redact('CC b@example.com and a@example.com');

    expect(first).toBe('From [EMAIL_1]');
    expect(second).toBe('CC [EMAIL_2] and [EMAIL_1]');
    expect(redactor.redactions).toHaveLength(2);
  });

  it('is reversible, so an agent sees the original', () => {
    const original = 'Mail a@example.com or call +49 30 1234 5678 about card 4111111111111111';
    const { text, redactions } = redactPii(original);

    expect(text).not.toContain('a@example.com');
    expect(restorePii(text, redactions)).toBe(original);
  });
});

describe('digit folding', () => {
  it('turns both Arabic digit sets into ASCII', () => {
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789 0123456789');
  });
});
