import type { Attachment, MetaAccount, MetaConversation, MetaDelivery } from '@helpdock/db';
import { metaDeliverySchema, metaTicketContextSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { deliveryFacts, toMetaDelivery, toMetaTicketContext } from './meta-view.js';

const ID = '01924f00-0000-7000-8000-0000000000aa';
const stamp = new Date('2026-10-11T09:00:00.000Z');

const attachment = (
  overrides: Partial<Pick<Attachment, 'id' | 'originalName' | 'status' | 'kind' | 'variants'>> = {},
) => ({
  id: ID,
  originalName: 'warranty-terms.docx',
  status: 'ready' as const,
  kind: 'file' as const,
  variants: { original: { mime: 'application/msword', size: 900 } },
  ...overrides,
});

describe('deliveryFacts', () => {
  it('counts the text in its parts and one message for every attachment', () => {
    const text = `${'a'.repeat(1_999)} ${'b'.repeat(500)}`;

    expect(deliveryFacts('messenger', text, [attachment(), attachment()]).partsTotal).toBe(4);
    expect(deliveryFacts('whatsapp', text, []).partsTotal).toBe(1);
  });

  it('counts a reply that is only a file as one message', () => {
    expect(deliveryFacts('whatsapp', '', [attachment()]).partsTotal).toBe(1);
  });

  it('names the files the platform will not take, and the reason', () => {
    const facts = deliveryFacts('instagram', 'Our terms.', [
      attachment(),
      attachment({
        id: '01924f00-0000-7000-8000-0000000000bb',
        originalName: 'warranty.pdf',
        variants: { original: { mime: 'application/pdf', size: 900 } },
      }),
      attachment({
        id: '01924f00-0000-7000-8000-0000000000cc',
        originalName: 'huge.pdf',
        variants: { original: { mime: 'application/pdf', size: 26 * 1024 * 1024 } },
      }),
    ]);

    expect(facts.leftOut).toEqual([
      { attachmentId: ID, name: 'warranty-terms.docx', reason: 'unsupported-type' },
      {
        attachmentId: '01924f00-0000-7000-8000-0000000000cc',
        name: 'huge.pdf',
        reason: 'too-large',
      },
    ]);
    expect(facts.partsTotal).toBe(4);
  });

  it('does not list a file the pipeline refused: the composer showed that when it was added', () => {
    expect(
      deliveryFacts('whatsapp', 'Hi', [attachment({ status: 'rejected', variants: {} })]).leftOut,
    ).toEqual([]);
  });
});

describe('toMetaDelivery', () => {
  const row = {
    id: ID,
    ticketMessageId: '01924f00-0000-7000-8000-0000000000dd',
    status: 'read',
    partsSent: 2,
    attempts: 1,
    lastError: null,
    errorCode: null,
    tag: null,
    templateName: null,
    sentAt: stamp,
    deliveredAt: stamp,
    readAt: stamp,
    failedAt: null,
    // What a client must never read: the recipient, Meta's ids, the account.
    customerId: 'US.13491208655302741918',
    platformMessageIds: ['wamid.secret'],
    accountId: ID,
    brandId: ID,
  } as unknown as MetaDelivery;

  it('is what the schema describes, with the dates as ISO strings', () => {
    const view = toMetaDelivery(row, { partsTotal: 3, leftOut: [] });

    expect(metaDeliverySchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      status: 'read',
      partsSent: 2,
      partsTotal: 3,
      sentAt: '2026-10-11T09:00:00.000Z',
      failedAt: null,
    });
  });

  it('leaves the recipient and Meta’s message ids out', () => {
    const view = toMetaDelivery(row, { partsTotal: 1, leftOut: [] });

    expect(JSON.stringify(view)).not.toContain('US.13491208655302741918');
    expect(JSON.stringify(view)).not.toContain('wamid.secret');
    expect(view).not.toHaveProperty('customerId');
    expect(view).not.toHaveProperty('platformMessageIds');
  });
});

describe('toMetaTicketContext', () => {
  const account = (overrides: Partial<MetaAccount> = {}): MetaAccount =>
    ({
      id: ID,
      platform: 'whatsapp',
      externalId: '106540352242922',
      displayName: 'Acme Support',
      username: null,
      displayPhone: '+1 555 0142',
      // The token must not travel.
      accessToken: 'v1.key.sealed',
      ...overrides,
    }) as MetaAccount;
  const conversation = (overrides: Partial<MetaConversation> = {}): MetaConversation =>
    ({
      customerId: 'US.13491208655302741918',
      waId: '16505551234',
      profileName: 'Daniel Reyes',
      username: null,
      ...overrides,
    }) as MetaConversation;
  const window = { state: 'open', closesAt: new Date('2026-10-12T09:00:00.000Z') } as const;

  it('reads a WhatsApp conversation: the number as Meta sent it is verified, with the display form of ours', () => {
    const context = toMetaTicketContext({
      account: account(),
      conversation: conversation(),
      window,
    });

    expect(metaTicketContextSchema.parse(context)).toEqual(context);
    expect(context).toEqual({
      account: {
        id: ID,
        platform: 'whatsapp',
        externalId: '106540352242922',
        displayName: 'Acme Support',
        displayPhone: '+1 555 0142',
      },
      customerId: 'US.13491208655302741918',
      phone: '+16505551234',
      phoneVerified: true,
      profileName: 'Daniel Reyes',
      window: { state: 'open', closesAt: '2026-10-12T09:00:00.000Z' },
    });
    expect(JSON.stringify(context)).not.toContain('sealed');
  });

  it('says no phone, and not verified, for a WhatsApp customer who withheld their number', () => {
    const context = toMetaTicketContext({
      account: account(),
      conversation: conversation({ waId: null }),
      window,
    });

    expect(context).not.toHaveProperty('phone');
    expect(context.phoneVerified).toBe(false);
  });

  it('reads an Instagram conversation: the handle on both sides, never a verified phone', () => {
    const context = toMetaTicketContext({
      account: account({
        platform: 'instagram',
        username: 'acme_support',
        displayPhone: null,
        externalId: '17841400000000000',
      }),
      conversation: conversation({ customerId: '6001', waId: null, username: 'mona_k' }),
      window: { state: 'closed', closedAt: new Date('2026-10-11T08:00:00.000Z') },
    });

    expect(context).toMatchObject({
      account: { platform: 'instagram', username: 'acme_support' },
      customerId: '6001',
      username: 'mona_k',
      phoneVerified: false,
      window: { state: 'closed', closedAt: '2026-10-11T08:00:00.000Z' },
    });
    expect(context.account).not.toHaveProperty('displayPhone');
  });
});
