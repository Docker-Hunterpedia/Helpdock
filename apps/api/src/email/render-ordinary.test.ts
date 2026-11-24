import { describe, expect, it } from 'vitest';
import { deliveryRow, TICKET } from '../testing/email-fixtures.js';
import type { SendFacts } from './email.repository.js';
import { templatesFor } from './outgoing-settings.js';
import { renderDelivery } from './render-delivery.js';

/**
 * An ordinary reply (no target) renders byte for byte as it did before M14-31.
 * The snapshot was written against the code of `main` before that change.
 */
const facts: SendFacts = {
  ticket: { id: TICKET, reference: 'HD-1042', subject: 'Refund not received', contactId: null },
  brandName: 'Helpdock',
  departmentName: 'Billing',
  contactName: 'Mona Khalil',
  isSpam: false,
  message: {
    bodyHtml: '<p>Your refund was issued.</p><p>Second paragraph.</p>',
    bodyText: 'Your refund was issued.\n\nSecond paragraph.',
    authorId: 'lina',
    authorType: 'staff',
  },
  author: {
    name: 'Lina Haddad',
    publicName: null,
    jobTitleEn: null,
    jobTitleAr: null,
    publicPhone: null,
    signatureEn: 'Lina Haddad\nBilling team',
    signatureAr: 'لينا حداد\nفريق الفوترة',
  },
  replyTarget: null,
  transcript: [],
};

const thread = {
  inReplyTo: 'customer@mail.example',
  references: ['first@mail.example', 'customer@mail.example'],
};

describe('an ordinary reply', () => {
  it.each(['en', 'ar'] as const)('renders as it always did in %s', (locale) => {
    const message = renderDelivery({
      delivery: deliveryRow({ locale }),
      facts,
      thread,
      templates: (kind) => templatesFor(undefined, kind),
    });

    expect(message).toMatchSnapshot();
  });
});
