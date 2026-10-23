import { describe, expect, it } from 'vitest';
import { deliveryRow, MESSAGE, TICKET } from '../testing/email-fixtures.js';
import type { EmailAuthor, SendFacts } from './email.repository.js';
import { autoRepliesFrom, templatesFor } from './outgoing-settings.js';
import { renderDelivery, signatureFor } from './render-delivery.js';

const LINA: EmailAuthor = {
  name: 'Lina Haddad',
  publicName: null,
  jobTitleEn: null,
  jobTitleAr: null,
  publicPhone: null,
  signatureEn: 'Lina Haddad\nBilling team',
  signatureAr: null,
};

const facts: SendFacts = {
  ticket: { id: TICKET, reference: 'HD-1042', subject: 'Refund not received', contactId: null },
  brandName: 'Helpdock',
  departmentName: 'Billing',
  contactName: 'Mona Khalil',
  message: {
    bodyHtml: '<p>Your refund was issued.</p>',
    bodyText: 'Your refund was issued.',
    authorId: 'lina',
    authorType: 'staff',
  },
  author: LINA,
  transcript: [],
};

const thread = { inReplyTo: '<customer@mail.example>', references: ['<customer@mail.example>'] };
const templates = (kind: 'acknowledgment' | 'outOfHours') => templatesFor(undefined, kind);

describe('renderDelivery, an agent reply', () => {
  const message = renderDelivery({ delivery: deliveryRow(), facts, thread, templates });

  it('goes out as "Agent via Department" with the frozen addressing', () => {
    expect(message.from).toEqual({
      address: 'billing@helpdock.io',
      name: 'Lina via Helpdock Billing',
    });
    expect(message.to).toEqual({ address: 'mona@example.com', name: 'Mona Khalil' });
    expect(message.cc).toEqual([{ address: 'karim@acme.de' }]);
    expect(message.replyTo).toBe('billing-replies@helpdock.io');
  });

  it('carries the deterministic Message-ID and threads under the customer', () => {
    expect(message.messageId).toBe(`<hd.m.${MESSAGE}@helpdock.io>`);
    expect(message.inReplyTo).toBe('<customer@mail.example>');
    expect(message.references).toEqual(['<customer@mail.example>']);
    expect(message.headers).toBeUndefined();
  });

  it('keeps the reference in the subject and draws the marker, body and signature', () => {
    expect(message.subject).toBe('Re: [HD-1042] Refund not received');
    expect(message.html).toContain('##- Please type your reply above this line -##');
    expect(message.html).toContain('<p>Your refund was issued.</p>');
    expect(message.text).toContain('Billing team');
  });
});

describe('renderDelivery, an auto-reply', () => {
  const delivery = deliveryRow({
    kind: 'acknowledgment',
    ticketMessageId: null,
    ccAddresses: [],
    replyTo: null,
    toName: null,
    locale: 'ar',
  });
  const message = renderDelivery({
    delivery,
    facts: { ...facts, message: null, author: null },
    thread: { inReplyTo: undefined, references: [] },
    templates,
  });

  it('fills the template in the contact language and carries the loop-protection headers', () => {
    expect(message.subject).toBe('[HD-1042] استلمنا رسالتك');
    expect(message.text).toContain('مرحباً Mona');
    expect(message.headers).toMatchObject({ 'Auto-Submitted': 'auto-replied', Precedence: 'bulk' });
    expect(message.from).toEqual({ address: 'billing@helpdock.io', name: 'Helpdock Billing' });
  });

  it('has no reply marker, no signature and no In-Reply-To', () => {
    expect(message.html).not.toContain('##-');
    expect(message.inReplyTo).toBeUndefined();
    expect(message.replyTo).toBeUndefined();
    expect(message.html).toContain('dir="rtl"');
  });

  it("uses the brand's own wording for the out-of-hours reply", () => {
    const own = autoRepliesFrom(undefined).outOfHours.templates;
    const rendered = renderDelivery({
      delivery: deliveryRow({ kind: 'out_of_hours', ticketMessageId: null, locale: 'en' }),
      facts,
      thread: { inReplyTo: undefined, references: [] },
      templates: () => ({
        ...own,
        en: { subject: 'Closed now', body: 'Back at 9, {{contact.first_name}}.' },
      }),
    });

    expect(rendered.subject).toBe('Closed now');
    expect(rendered.text).toContain('Back at 9, Mona.');
  });
});

describe('signatureFor', () => {
  const author = (overrides: Partial<EmailAuthor> = {}): EmailAuthor => ({ ...LINA, ...overrides });
  const context = { brandName: 'Helpdock', departmentName: 'Billing' };

  it('falls back from an empty Arabic signature to the English one', () => {
    expect(signatureFor(LINA, 'ar', context)).toBe('Lina Haddad\nBilling team');
    expect(signatureFor(author({ signatureEn: 'Lina', signatureAr: 'لينا' }), 'ar', context)).toBe(
      'لينا',
    );
  });

  it('is null when the author has none, or there is no author', () => {
    expect(signatureFor(author({ signatureEn: '  ' }), 'en', context)).toBeNull();
    expect(signatureFor(null, 'en', context)).toBeNull();
  });

  it('fills the agent placeholders from the public profile (M14-12)', () => {
    const signed = author({
      publicName: 'Lina',
      jobTitleEn: 'Billing specialist',
      jobTitleAr: 'أخصائية الفوترة',
      publicPhone: '+966551234567',
      signatureEn: '{{agent.name}}\n{{agent.title}} · {{brand.name}}\n{{agent.phone}}',
      signatureAr: '{{agent.name}}\n{{agent.title}} · {{department.name}}',
    });

    expect(signatureFor(signed, 'en', context)).toBe(
      'Lina\nBilling specialist · Helpdock\n+966551234567',
    );
    expect(signatureFor(signed, 'ar', context)).toBe('Lina\nأخصائية الفوترة · Billing');
  });

  it('drops the line of a placeholder the person left empty, and never prints the full name unasked', () => {
    const signed = author({
      signatureEn: '{{agent.name}}\n{{agent.title}} · {{brand.name}}\n{{agent.phone}}',
    });

    expect(signatureFor(signed, 'en', context)).toBe('Lina\nHelpdock');
    expect(signatureFor(signed, 'en', context)).not.toContain('Haddad');
  });
});

describe('the From name of an agent reply (M14-12)', () => {
  it('shows the public name and never the full one', () => {
    const named = { ...facts, author: { ...LINA, publicName: 'Lina H' } };
    const message = renderDelivery({ delivery: deliveryRow(), facts: named, thread, templates });

    expect(message.from?.name).toContain('Lina H');
    expect(message.from?.name).not.toContain('Haddad');
  });

  it('falls back to the first name when no public name is set', () => {
    const message = renderDelivery({ delivery: deliveryRow(), facts, thread, templates });

    expect(message.from?.name).toContain('Lina');
    expect(message.from?.name).not.toContain('Haddad');
  });
});

describe('renderDelivery, a widget transcript (M4-08)', () => {
  const delivery = deliveryRow({
    kind: 'transcript',
    ticketMessageId: null,
    ccAddresses: [],
    toName: null,
    toAddress: 'visitor@example.com',
    messageId: '<hd.t.delivery@helpdock.io>',
  });
  const message = renderDelivery({
    delivery,
    facts: {
      ...facts,
      message: null,
      author: null,
      transcript: [
        {
          from: 'visitor',
          agentName: null,
          text: 'Where is <my> order?',
          at: new Date('2026-09-27T10:00:00Z'),
        },
        {
          from: 'agent',
          agentName: 'Lina',
          text: 'On its way.',
          at: new Date('2026-09-27T10:01:00Z'),
        },
      ],
    },
    thread: { inReplyTo: undefined, references: [] },
    templates,
  });

  it('carries the conversation, escaped, to the address typed and nobody else', () => {
    expect(message.subject).toBe('Your chat with Helpdock [HD-1042]');
    expect(message.to).toEqual({ address: 'visitor@example.com' });
    expect(message.cc).toEqual([]);
    expect(message.html).toContain('Where is &lt;my&gt; order?');
    expect(message.text).toContain('Lina · ');
    expect(message.text).toContain('This email holds this conversation only');
  });

  it('is not an auto-reply, so it carries no loop-protection headers and no reply marker', () => {
    expect(message.headers).toBeUndefined();
    expect(message.html).not.toContain('##-');
  });
});
