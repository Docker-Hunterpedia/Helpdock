import { describe, expect, it } from 'vitest';
import { contactDuplicateReasonSchema, contactRefusalSchema } from './contact.js';
import { contactMergePreviewSchema, contactMergeRequestSchema } from './contact-merge.js';
import { ticketCcRequestSchema, ticketParticipantListSchema } from './participants.js';

const ID = '01937f5e-7e53-7000-8000-000000000001';
const OTHER = '01937f5e-7e53-7000-8000-000000000002';

describe('contact merge schemas (M1-13)', () => {
  it('names the contact to fold in, and optionally the suggestion it came from', () => {
    expect(contactMergeRequestSchema.parse({ mergedContactId: ID })).toEqual({
      mergedContactId: ID,
    });
    expect(contactMergeRequestSchema.safeParse({ mergedContactId: 'mona' }).success).toBe(false);
  });

  it('carries ticket counts and each identifier with the contact it is on', () => {
    const side = (id: string) => ({ id, name: 'Mona', accountName: null, ticketCount: 2 });
    const preview = contactMergePreviewSchema.parse({
      contact: side(ID),
      other: side(OTHER),
      identities: [
        {
          id: ID,
          contactId: OTHER,
          kind: 'email',
          value: 'mona@example.com',
          verified: false,
          verifiedAt: null,
          source: 'widget.form',
        },
      ],
    });

    expect(preview.identities[0]?.contactId).toBe(OTHER);
    expect(
      contactMergePreviewSchema.safeParse({ ...preview, contact: { ...side(ID), ticketCount: -1 } })
        .success,
    ).toBe(false);
  });

  it('adds the name reason and the merge refusals beside the M1-04 ones', () => {
    expect(contactDuplicateReasonSchema.options).toContain('similar_name');
    expect(contactRefusalSchema.options).toEqual(
      expect.arrayContaining(['merged', 'merge-self', 'merge-expired', 'merge-blocked']),
    );
  });
});

describe('participant schemas (M1-13)', () => {
  it('trims a CC address and refuses an empty one', () => {
    expect(ticketCcRequestSchema.parse({ email: '  finance@acme.de ' }).email).toBe(
      'finance@acme.de',
    );
    expect(ticketCcRequestSchema.safeParse({ email: '   ' }).success).toBe(false);
  });

  it('allows a ticket with no contact and a CC with no address', () => {
    const list = ticketParticipantListSchema.parse({
      contact: null,
      ccs: [{ id: ID, contactId: OTHER, name: 'Finance', address: null, source: 'merge' }],
      staff: [],
    });

    expect(list.ccs[0]?.address).toBeNull();
  });
});
