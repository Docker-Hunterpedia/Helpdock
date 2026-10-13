import { describe, expect, it } from 'vitest';
import { type MetaMessageEvent, metaEnvelopeSchema, routeEnvelope } from './envelope.js';
import {
  fixtureMid,
  fixtureWamid,
  instagramStoryMention,
  instagramStoryReply,
  instagramText,
  META_FIXTURE,
  type MetaWebhookBody,
  pageAttachment,
  pageFallback,
  pageText,
  whatsappContacts,
  whatsappImage,
  whatsappLocation,
  whatsappNoWaId,
  whatsappText,
} from './fixtures.js';
import type { MetaInboundInput, MetaInboundLabels } from './inbound-message.js';
import { toInstagramInboundMessage } from './instagram/instagram-adapter.js';
import { toMessengerInboundMessage } from './messenger/messenger-adapter.js';
import { toWhatsAppInboundMessage } from './whatsapp/whatsapp-adapter.js';

const RECEIVED = new Date('2026-10-11T08:00:05.000Z');

const LABELS: MetaInboundLabels = {
  location: 'Location',
  contact: 'Contact',
  story: { reply: 'Replied to your story', mention: 'Mentioned you in their story' },
};

const eventOf = (body: MetaWebhookBody): MetaMessageEvent => {
  const event = routeEnvelope(metaEnvelopeSchema.parse(body)).routes[0]?.events[0];
  if (event?.kind !== 'message') {
    throw new Error(`expected a message, got ${event?.kind ?? 'nothing'}`);
  }

  return event;
};

const inputOf = (body: MetaWebhookBody, accountExternalId: string): MetaInboundInput => ({
  event: eventOf(body),
  accountExternalId,
  labels: LABELS,
});

describe('a WhatsApp message', () => {
  it('is filed on the user id, with the profile name, the wamid as its dedupe key and no files yet', () => {
    const message = toWhatsAppInboundMessage(
      inputOf(
        whatsappText({ wamid: fixtureWamid(7), text: 'Does it come in blue?' }),
        META_FIXTURE.phoneNumberId,
      ),
      RECEIVED,
    );

    expect(message).toMatchObject({
      channel: 'whatsapp',
      externalId: fixtureWamid(7),
      from: { kind: 'whatsapp', value: META_FIXTURE.userId, name: META_FIXTURE.profileName },
      cc: [],
      subject: '',
      bodyText: 'Does it come in blue?',
      files: [],
      hints: { messageIds: [], ticketNumbers: [] },
      receivedAt: RECEIVED,
      meta: {
        platform: 'whatsapp',
        accountExternalId: META_FIXTURE.phoneNumberId,
        customerId: META_FIXTURE.userId,
        messageId: fixtureWamid(7),
        quotedId: null,
        fileRefs: [],
        profileName: META_FIXTURE.profileName,
        username: null,
        waId: META_FIXTURE.waId,
      },
    });
    expect(message.bodyHtml).toContain('Does it come in blue?');
  });

  it('carries the file as a reference to fetch later, not as a file', () => {
    const message = toWhatsAppInboundMessage(
      inputOf(whatsappImage({ mediaId: '555', caption: 'The corner' }), META_FIXTURE.phoneNumberId),
      RECEIVED,
    );

    expect(message.files).toEqual([]);
    expect(message.meta.fileRefs).toMatchObject([{ kind: 'whatsapp_media', mediaId: '555' }]);
    expect(message.bodyText).toBe('The corner');
  });

  it('writes a location as the label, the point and a map link, localised by the label it is given', () => {
    const message = toWhatsAppInboundMessage(
      {
        ...inputOf(
          whatsappLocation({ latitude: 52.52, longitude: 13.405 }),
          META_FIXTURE.phoneNumberId,
        ),
        labels: { ...LABELS, location: 'الموقع' },
      },
      RECEIVED,
    );

    expect(message.bodyText.split('\n')[0]).toBe('الموقع: 52.52, 13.405');
    expect(message.bodyText).toContain('openstreetmap.org');
  });

  it('writes shared contacts as text, after the message', () => {
    const message = toWhatsAppInboundMessage(
      inputOf(whatsappContacts(), META_FIXTURE.phoneNumberId),
      RECEIVED,
    );

    expect(message.bodyText).toContain('Contact: Mona Khalil');
    expect(message.bodyText).toContain('mona@example.com');
  });

  it('is filed on the user id alone, named by the username, when Meta withheld the number', () => {
    const message = toWhatsAppInboundMessage(
      inputOf(whatsappNoWaId({ username: 'sheena.nelson' }), META_FIXTURE.phoneNumberId),
      RECEIVED,
    );

    expect(message.from.value).toBe(META_FIXTURE.userId);
    expect(message.meta).toMatchObject({ waId: null, username: 'sheena.nelson' });
  });

  it('keeps the message it answers, so the thread can quote it', () => {
    const message = toWhatsAppInboundMessage(
      inputOf(whatsappText({ quotes: fixtureWamid(3) }), META_FIXTURE.phoneNumberId),
      RECEIVED,
    );

    expect(message.meta.quotedId).toBe(fixtureWamid(3));
  });

  it('sanitises what the customer typed, as every channel’s body is', () => {
    const message = toWhatsAppInboundMessage(
      inputOf(
        whatsappText({ text: '<script>alert(1)</script><b>bold</b>' }),
        META_FIXTURE.phoneNumberId,
      ),
      RECEIVED,
    );

    expect(message.bodyHtml).not.toContain('<script');
    expect(message.bodyHtml).not.toContain('<b>');
  });
});

describe('a Messenger message', () => {
  it('is filed on the Page and the page-scoped id together, with no name', () => {
    const message = toMessengerInboundMessage(
      inputOf(pageText({ mid: fixtureMid(4), text: 'Hello' }), META_FIXTURE.pageId),
      RECEIVED,
    );

    expect(message).toMatchObject({
      channel: 'messenger',
      externalId: fixtureMid(4),
      from: { kind: 'messenger', value: `${META_FIXTURE.pageId}:${META_FIXTURE.psid}`, name: null },
      meta: { platform: 'messenger', waId: null, profileName: null, customerId: META_FIXTURE.psid },
    });
  });

  it('carries an attachment as a CDN reference', () => {
    const message = toMessengerInboundMessage(
      inputOf(pageAttachment({ url: 'https://x.fbcdn.net/a.jpg' }), META_FIXTURE.pageId),
      RECEIVED,
    );

    expect(message.meta.fileRefs).toEqual([
      { kind: 'cdn_url', url: 'https://x.fbcdn.net/a.jpg', type: 'image' },
    ]);
    expect(message.bodyText).toBe('');
  });

  it('writes a shared link as its title and URL', () => {
    const message = toMessengerInboundMessage(
      inputOf(
        pageFallback({ url: 'https://maps.example.com/x', title: 'Brandenburg Gate' }),
        META_FIXTURE.pageId,
      ),
      RECEIVED,
    );

    expect(message.bodyText).toBe('Brandenburg Gate\nhttps://maps.example.com/x');
  });
});

describe('an Instagram message', () => {
  it('is filed on the account and the Instagram-scoped id together', () => {
    const message = toInstagramInboundMessage(
      inputOf(instagramText({ mid: fixtureMid(9) }), META_FIXTURE.igAccountId),
      RECEIVED,
    );

    expect(message).toMatchObject({
      channel: 'instagram',
      externalId: fixtureMid(9),
      from: { kind: 'instagram', value: `${META_FIXTURE.igAccountId}:${META_FIXTURE.igsid}` },
    });
  });

  it('names a story reply in the body and carries the story’s media', () => {
    const message = toInstagramInboundMessage(
      inputOf(
        instagramStoryReply({ text: 'Love it', url: 'https://x.fbsbx.com/s' }),
        META_FIXTURE.igAccountId,
      ),
      RECEIVED,
    );

    // The sanitiser reads each paragraph as a line of the plain text.
    expect(message.bodyText).toBe('Love it\nReplied to your story\nhttps://x.fbsbx.com/s');
    expect(message.meta.fileRefs).toEqual([
      { kind: 'cdn_url', url: 'https://x.fbsbx.com/s', type: 'story' },
    ]);
  });

  it('names a story mention in the body, which has no text of its own', () => {
    const message = toInstagramInboundMessage(
      inputOf(instagramStoryMention({ url: 'https://x.fbsbx.com/m' }), META_FIXTURE.igAccountId),
      RECEIVED,
    );

    expect(message.bodyText).toBe('Mentioned you in their story\nhttps://x.fbsbx.com/m');
  });

  it('names the contact by the handle when Instagram gave no name', () => {
    const input = inputOf(instagramText(), META_FIXTURE.igAccountId);
    const withHandle = { ...input, event: { ...input.event, username: 'mona_k' } };

    expect(toInstagramInboundMessage(withHandle, RECEIVED).from.name).toBe('@mona_k');
  });
});

describe('giving a message to the wrong adapter', () => {
  it('throws, because a Messenger message filed as Instagram would carry the wrong identity', () => {
    expect(() =>
      toInstagramInboundMessage(inputOf(pageText(), META_FIXTURE.pageId), RECEIVED),
    ).toThrow(TypeError);
    expect(() =>
      toWhatsAppInboundMessage(inputOf(instagramText(), META_FIXTURE.igAccountId), RECEIVED),
    ).toThrow('A instagram message was given to the whatsapp adapter');
  });
});

describe('the per-platform functions', () => {
  it.each([
    ['whatsapp', toWhatsAppInboundMessage, whatsappText(), META_FIXTURE.phoneNumberId],
    ['messenger', toMessengerInboundMessage, pageText(), META_FIXTURE.pageId],
    ['instagram', toInstagramInboundMessage, instagramText(), META_FIXTURE.igAccountId],
  ] as const)(
    '%s files an inbound message stamped with the time it was given',
    (kind, toMessage, body, account) => {
      const message = toMessage(inputOf(body, account), RECEIVED);

      expect(message.channel).toBe(kind);
      expect(message.receivedAt).toEqual(RECEIVED);
    },
  );
});
