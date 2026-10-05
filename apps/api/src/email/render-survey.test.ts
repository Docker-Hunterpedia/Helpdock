import { describe, expect, it } from 'vitest';
import { deliveryRow, TICKET } from '../testing/email-fixtures.js';
import type { SendFacts } from './email.repository.js';
import { templatesFor } from './outgoing-settings.js';
import { renderDelivery } from './render-delivery.js';

/**
 * M8-06's survey email (`Email/CSAT-EN-AR`). The snapshots hold the whole
 * HTML and plain-text parts in both languages, so a change to the layout, the
 * words or the links shows up in review as the message a customer would get.
 */

const SURVEY = '0199f4b2-4444-7000-8000-0000000000cc';

const facts = (locale: 'en' | 'ar'): SendFacts => ({
  ticket: {
    id: TICKET,
    reference: 'HD-1042',
    subject: locale === 'ar' ? 'استفسار عن رسوم الشحن الدولي' : 'Refund for order 8841',
    contactId: null,
  },
  brandName: 'Helpdock',
  departmentName: 'Billing',
  contactName: locale === 'ar' ? 'سارة منصور' : 'Mona Khalil',
  message: null,
  author: null,
  transcript: [],
});

const render = (locale: 'en' | 'ar', closedBy: string | null = locale === 'ar' ? 'لينا' : 'Lina') =>
  renderDelivery({
    delivery: deliveryRow({
      kind: 'csat',
      ticketMessageId: null,
      csatResponseId: SURVEY,
      locale,
      toName: locale === 'ar' ? 'سارة منصور' : 'Mona Khalil',
      ccAddresses: ['karim@acme.de'],
      messageId: `<hd.c.${SURVEY}@helpdock.io>`,
    }),
    facts: facts(locale),
    thread: { inReplyTo: '<customer@mail.example>', references: ['<customer@mail.example>'] },
    templates: (kind) => templatesFor(undefined, kind),
    survey: {
      links: [1, 2, 3, 4, 5].map(
        (rating) => `https://desk.helpdock.io/csat/tok?rating=${String(rating)}&lang=${locale}`,
      ),
      closedBy,
    },
  });

describe('renderDelivery, a satisfaction survey', () => {
  it('matches the English artboard', () => {
    const message = render('en');

    expect(message.subject).toBe('[HD-1042] How did we do?');
    expect(message.html).toMatchSnapshot('html');
    expect(message.text).toMatchSnapshot('text');
  });

  it('matches the Arabic artboard, laid out right to left', () => {
    const message = render('ar');

    expect(message.subject).toBe('[HD-1042] ما رأيك في خدمتنا؟');
    expect(message.html).toContain('dir="rtl"');
    expect(message.html).toMatchSnapshot('html');
    expect(message.text).toMatchSnapshot('text');
  });

  it('goes to the contact alone, threaded, as an automatic message with no reply marker', () => {
    const message = render('en');

    expect(message.to).toEqual({ address: 'mona@example.com', name: 'Mona Khalil' });
    expect(message.cc).toEqual([]);
    expect(message.messageId).toBe(`<hd.c.${SURVEY}@helpdock.io>`);
    expect(message.inReplyTo).toBe('<customer@mail.example>');
    expect(message.headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
    expect(message.html).not.toContain('Please type your reply above this line');
  });

  it('says the request was closed without naming anybody when the page may not', () => {
    expect(render('en', null).text).toContain(
      'Your request HD-1042 was closed today. We would like to know how it went.',
    );
  });

  it('refuses to render without its survey', () => {
    expect(() =>
      renderDelivery({
        delivery: deliveryRow({ kind: 'csat', csatResponseId: SURVEY }),
        facts: facts('en'),
        thread: { inReplyTo: undefined, references: [] },
        templates: (kind) => templatesFor(undefined, kind),
      }),
    ).toThrow(/without its survey/);
  });
});
