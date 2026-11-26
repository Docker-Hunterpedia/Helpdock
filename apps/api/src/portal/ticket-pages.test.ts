import { describe, expect, it } from 'vitest';
import { translator } from '../help-center/site/render/text.js';
import { ticketMain } from './ticket-pages.js';
import type { PortalMessage, PortalTicket } from './ticket-views.js';

const ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const message = (over: Partial<PortalMessage>): PortalMessage => ({
  id: ID,
  author: { kind: 'you' },
  at: '2026-11-10T11:48:00.000Z',
  text: 'Hello',
  truncated: false,
  attachments: [],
  moreFiles: 0,
  ...over,
});
const page = (messages: PortalMessage[], locale: 'en' | 'ar' = 'en'): string => {
  const ticket: PortalTicket = {
    reference: 'HD-1',
    subject: 'Subject',
    status: 'open',
    openedBy: { kind: 'you' },
    createdAt: '2026-11-10T11:48:00.000Z',
    channel: 'email',
    mine: true,
    messages,
  };
  return ticketMain({
    t: translator(locale),
    locale,
    timeZone: 'UTC',
    brandName: 'Helpdock',
    listHref: '/tickets',
    attachmentPath: (ref, id) => `/tickets/${ref}/attachments/${id}`,
    ticket,
  });
};

describe('a long message and many files', () => {
  it('says a clipped message is shown in part, in both languages', () => {
    expect(page([message({ truncated: true })])).toContain(
      'This message is long and is shown in part.',
    );
    expect(page([message({ truncated: true })], 'ar')).toContain('هذه الرسالة طويلة وتظهر جزئيًا.');
    expect(page([message({})])).not.toContain('shown in part');
  });

  it('says how many files are not listed, with the plural of each language', () => {
    expect(page([message({ moreFiles: 1 })])).toContain('and 1 more file<');
    expect(page([message({ moreFiles: 7 })])).toContain('and 7 more files');
    expect(page([message({ moreFiles: 2 })], 'ar')).toContain('و2 ملفين آخرين');
    expect(page([message({ moreFiles: 7 })], 'ar')).toContain('و7 ملفات أخرى');
    expect(page([message({ moreFiles: 0 })])).not.toContain('more file');
  });
});
