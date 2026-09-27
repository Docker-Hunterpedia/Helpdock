import { describe, expect, it } from 'vitest';
import {
  customerCopy,
  defaultAutoReplyTemplate,
  fillPlaceholders,
  firstNameOf,
  outgoingTestCopy,
} from './email-copy.js';

const values = {
  ticketNumber: 'HD-1042',
  contactFirstName: 'Mona',
  departmentName: 'Billing',
  brandName: 'Helpdock',
};

describe('defaultAutoReplyTemplate', () => {
  it('keeps the placeholders the editor shows, rather than interpolating them away', () => {
    const template = defaultAutoReplyTemplate('acknowledgment', 'en');

    expect(template.subject).toBe('[{{ticket.number}}] We received your message');
    expect(template.body).toContain('{{contact.first_name}}');
    expect(template.body).toContain('{{department.name}}');
  });

  it('has an Arabic wording of its own for both kinds', () => {
    expect(defaultAutoReplyTemplate('outOfHours', 'ar').body).toContain('{{ticket.number}}');
    expect(defaultAutoReplyTemplate('outOfHours', 'ar').body).not.toBe(
      defaultAutoReplyTemplate('outOfHours', 'en').body,
    );
  });
});

describe('fillPlaceholders', () => {
  it('fills the four placeholders wherever they appear', () => {
    expect(
      fillPlaceholders(
        '[{{ticket.number}}] Hi {{contact.first_name}}, {{department.name}} at {{brand.name}} ({{ticket.number}})',
        values,
      ),
    ).toBe('[HD-1042] Hi Mona, Billing at Helpdock (HD-1042)');
  });

  it('leaves a brace pair it does not know as it was typed', () => {
    expect(fillPlaceholders('Hi {{contact.last_name}}', values)).toBe('Hi {{contact.last_name}}');
  });
});

describe('firstNameOf', () => {
  it('takes the first word of a name', () => {
    expect(firstNameOf('  Mona   Khalil ', 'en')).toBe('Mona');
  });

  it("falls back to the catalog's greeting when there is no name", () => {
    expect(firstNameOf(null, 'en')).toBe('there');
    expect(firstNameOf('', 'ar')).toBe('بك');
  });
});

describe('customerCopy', () => {
  it('reads the Arabic catalog, mirrored', () => {
    const copy = customerCopy('ar', 'Helpdock');

    expect(copy.dir).toBe('rtl');
    expect(copy.referenceLabel).toBe('رقم الطلب');
    expect(copy.footer).toContain('Helpdock');
    expect(copy.fromVia('لينا حداد', 'Helpdock Billing')).toBe('لينا حداد عبر Helpdock Billing');
  });

  it('writes the reply subject with the reference in brackets', () => {
    expect(customerCopy('en', 'Helpdock').replySubject('HD-1042', 'Refund')).toBe(
      'Re: [HD-1042] Refund',
    );
  });
});

describe('outgoingTestCopy', () => {
  it('names the brand and the host', () => {
    const copy = outgoingTestCopy('en', { brandName: 'Helpdock', host: 'smtp.example.com' });

    expect(copy.subject).toBe('Helpdock test message');
    expect(copy.body).toContain('smtp.example.com');
  });
});
