import { describe, expect, it } from 'vitest';
import {
  classifyMessagingEvent,
  classifyWhatsAppValue,
  type MetaEvent,
  type MetaMessageEvent,
  metaEnvelopeSchema,
  metaExternalId,
  metaIdentityValue,
  platformOfObject,
  routeEnvelope,
} from './envelope.js';
import {
  fixtureMid,
  fixtureWamid,
  instagramAttachment,
  instagramDeleted,
  instagramEcho,
  instagramReaction,
  instagramSeen,
  instagramStoryMention,
  instagramStoryReply,
  instagramText,
  instagramUnsupported,
  META_FIXTURE,
  type MetaWebhookBody,
  pageAttachment,
  pageDelivery,
  pageEcho,
  pageEdit,
  pageFallback,
  pagePostback,
  pageReaction,
  pageRead,
  pageSticker,
  pageText,
  whatsappAudioVoice,
  whatsappContacts,
  whatsappDocument,
  whatsappImage,
  whatsappLocation,
  whatsappNoWaId,
  whatsappReaction,
  whatsappStatus,
  whatsappSticker,
  whatsappText,
  whatsappUnsupported,
  whatsappUserChangedNumber,
} from './fixtures.js';

/** Every fixture, by name, so one pass proves they all parse and classify. */
const FIXTURES: readonly (readonly [string, MetaWebhookBody])[] = [
  ['whatsappText', whatsappText()],
  ['whatsappImage', whatsappImage()],
  ['whatsappAudioVoice', whatsappAudioVoice()],
  ['whatsappDocument', whatsappDocument()],
  ['whatsappSticker', whatsappSticker()],
  ['whatsappLocation', whatsappLocation()],
  ['whatsappContacts', whatsappContacts()],
  ['whatsappReaction', whatsappReaction()],
  ['whatsappStatus', whatsappStatus()],
  ['whatsappUnsupported', whatsappUnsupported()],
  ['whatsappUserChangedNumber', whatsappUserChangedNumber()],
  ['whatsappNoWaId', whatsappNoWaId()],
  ['pageText', pageText()],
  ['pageAttachment', pageAttachment()],
  ['pageEcho', pageEcho()],
  ['pageDelivery', pageDelivery()],
  ['pageRead', pageRead()],
  ['pageReaction', pageReaction()],
  ['pageEdit', pageEdit()],
  ['pagePostback', pagePostback()],
  ['pageSticker', pageSticker()],
  ['pageFallback', pageFallback()],
  ['instagramText', instagramText()],
  ['instagramAttachment', instagramAttachment()],
  ['instagramStoryReply', instagramStoryReply()],
  ['instagramStoryMention', instagramStoryMention()],
  ['instagramEcho', instagramEcho()],
  ['instagramDeleted', instagramDeleted()],
  ['instagramUnsupported', instagramUnsupported()],
  ['instagramSeen', instagramSeen()],
  ['instagramReaction', instagramReaction()],
];

/** The events of a fixture that routes to exactly one account. */
const eventsOf = (body: MetaWebhookBody): readonly MetaEvent[] => {
  const { routes, unrouted } = routeEnvelope(metaEnvelopeSchema.parse(body));
  expect(unrouted).toEqual([]);
  expect(routes).toHaveLength(1);

  return routes[0]?.events ?? [];
};

const only = (body: MetaWebhookBody): MetaEvent => {
  const events = eventsOf(body);
  expect(events).toHaveLength(1);

  return events[0] as MetaEvent;
};

const messageOf = (body: MetaWebhookBody): MetaMessageEvent => {
  const event = only(body);
  expect(event.kind).toBe('message');

  return event as MetaMessageEvent;
};

describe('every fixture', () => {
  it.each(FIXTURES)(
    '%s is an envelope Helpdock reads and an event it understands',
    (_name, body) => {
      expect(metaEnvelopeSchema.safeParse(body).success).toBe(true);
      const events = eventsOf(body);

      expect(events.length).toBeGreaterThan(0);
      // A fixture that falls through to `ignored` is a fixture that has drifted.
      expect(events.filter((event) => event.kind === 'ignored')).toEqual([]);
    },
  );
});

describe('metaEnvelopeSchema', () => {
  it('routes on object, and refuses one Meta does not have', () => {
    expect(
      metaEnvelopeSchema.safeParse({ object: 'whatsapp_business_account', entry: [] }).success,
    ).toBe(true);
    expect(metaEnvelopeSchema.safeParse({ object: 'page', entry: [] }).success).toBe(true);
    expect(metaEnvelopeSchema.safeParse({ object: 'instagram', entry: [] }).success).toBe(true);
    expect(metaEnvelopeSchema.safeParse({ object: 'user', entry: [] }).success).toBe(false);
  });

  it.each([
    ['not an object', 'text'],
    ['no object', { entry: [] }],
    ['no entry', { object: 'page' }],
    ['an entry with no id', { object: 'page', entry: [{ messaging: [] }] }],
    ['an entry that is no object', { object: 'page', entry: ['x'] }],
    [
      'a change with no field',
      { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ value: {} }] }] },
    ],
  ])('refuses %s, which the route answers 400', (_label, body) => {
    expect(metaEnvelopeSchema.safeParse(body).success).toBe(false);
  });

  it('keeps fields it does not read, because Meta adds them in every version', () => {
    const parsed = metaEnvelopeSchema.parse({
      object: 'page',
      extra: true,
      entry: [{ id: '1', time: 1, messaging: [], future_field: 'x' }],
    });

    expect(parsed).toMatchObject({ extra: true });
  });

  it('takes a numeric entry id as the string it stands for, and refuses one JSON cannot hold exactly', () => {
    const parsed = metaEnvelopeSchema.parse({ object: 'instagram', entry: [{ id: 123456789012 }] });

    expect(parsed.entry[0]?.id).toBe('123456789012');
    // Past 2^53 a number has already lost digits; Meta writes such ids as strings.
    expect(
      metaEnvelopeSchema.safeParse({ object: 'instagram', entry: [{ id: 17841400000000000 }] })
        .success,
    ).toBe(false);
  });

  it('names the platform of each object', () => {
    expect(platformOfObject('whatsapp_business_account')).toBe('whatsapp');
    expect(platformOfObject('page')).toBe('messenger');
    expect(platformOfObject('instagram')).toBe('instagram');
  });
});

describe('WhatsApp messages', () => {
  it('files a text with the customer’s user id, number, name and the message id', () => {
    const event = messageOf(
      whatsappText({ wamid: fixtureWamid(7), text: 'Hello there', timestamp: 1_791_705_600 }),
    );

    expect(event).toMatchObject({
      platform: 'whatsapp',
      customerId: META_FIXTURE.userId,
      waId: META_FIXTURE.waId,
      profileName: META_FIXTURE.profileName,
      username: null,
      messageId: fixtureWamid(7),
      text: 'Hello there',
      quotedId: null,
      forwarded: false,
      files: [],
      location: null,
      contacts: [],
      story: null,
      links: [],
      errors: [],
    });
    expect(event.timestamp).toEqual(new Date('2026-10-11T08:00:00.000Z'));
  });

  it('reads the message a reply quotes, and a forward', () => {
    expect(messageOf(whatsappText({ quotes: fixtureWamid(3) })).quotedId).toBe(fixtureWamid(3));
    expect(messageOf(whatsappText({ forwarded: true }))).toMatchObject({
      forwarded: true,
      quotedId: null,
    });
  });

  it('names an image by its media id, type, digest and caption, and fetches nothing', () => {
    const event = messageOf(
      whatsappImage({ mediaId: '555', caption: 'The damaged corner', sha256: 'abc=' }),
    );

    expect(event.text).toBe('The damaged corner');
    expect(event.files).toEqual([
      {
        kind: 'whatsapp_media',
        type: 'image',
        mediaId: '555',
        mimeType: 'image/jpeg',
        sha256: 'abc=',
      },
    ]);
  });

  it('marks a voice note, and an audio file that is not one', () => {
    expect(messageOf(whatsappAudioVoice()).files[0]).toMatchObject({
      type: 'audio',
      mimeType: 'audio/ogg; codecs=opus',
      voice: true,
    });
    expect(messageOf(whatsappAudioVoice({ voice: false })).files[0]).toMatchObject({
      voice: false,
    });
  });

  it('keeps a document’s file name, and a sticker as the image it is', () => {
    expect(messageOf(whatsappDocument({ filename: 'order.pdf' })).files[0]).toMatchObject({
      type: 'document',
      filename: 'order.pdf',
      mimeType: 'application/pdf',
    });
    expect(messageOf(whatsappSticker()).files[0]).toMatchObject({
      type: 'sticker',
      mimeType: 'image/webp',
    });
  });

  it('files a location as its point, name and address', () => {
    expect(messageOf(whatsappLocation({ latitude: 25.2, longitude: 55.27 })).location).toEqual({
      latitude: 25.2,
      longitude: 55.27,
      name: 'Brandenburg Gate',
      address: 'Pariser Platz, 10117 Berlin',
      url: null,
    });
  });

  it('files shared contacts with their names, numbers, addresses and company', () => {
    expect(messageOf(whatsappContacts()).contacts).toEqual([
      {
        name: 'Mona Khalil',
        org: 'Khalil Trading',
        phones: ['+963 931 234 567'],
        emails: ['mona@example.com'],
      },
    ]);
  });

  it('keys a customer with no number on the user id and the username alone', () => {
    const event = messageOf(whatsappNoWaId({ username: 'sheena.nelson' }));

    expect(event).toMatchObject({
      customerId: META_FIXTURE.userId,
      waId: null,
      username: 'sheena.nelson',
      text: 'Hello from a username',
    });
  });

  it('falls back on the number when Meta sent no user id, rather than dropping the message', () => {
    const body = whatsappText();
    const value = (
      body.entry as { changes: { value: { contacts: { user_id?: string }[] } }[] }[]
    )[0]?.changes[0]?.value;
    delete value?.contacts[0]?.user_id;

    expect(messageOf(body).customerId).toBe(META_FIXTURE.waId);
  });

  it('matches each message to its own contact when a batch carries two customers', () => {
    const first = whatsappText({
      from: '111',
      userId: 'US.1',
      profileName: 'One',
      wamid: fixtureWamid(1),
    });
    const second = whatsappText({
      from: '222',
      userId: 'US.2',
      profileName: 'Two',
      wamid: fixtureWamid(2),
    });
    const value = (body: MetaWebhookBody) =>
      (body.entry as { changes: { value: Record<string, unknown[]> }[] }[])[0]?.changes[0]?.value ??
      {};
    const merged = {
      ...value(first),
      contacts: [...(value(first).contacts ?? []), ...(value(second).contacts ?? [])],
      messages: [...(value(first).messages ?? []), ...(value(second).messages ?? [])],
    };
    const events = classifyWhatsAppValue(merged);

    expect(events.map((event) => event.kind === 'message' && event.customerId)).toEqual([
      'US.1',
      'US.2',
    ]);
    expect(events.map((event) => event.kind === 'message' && event.profileName)).toEqual([
      'One',
      'Two',
    ]);
  });

  it('files a reaction as a reaction to the message it names, and an empty emoji as its removal', () => {
    expect(only(whatsappReaction({ reactsTo: fixtureWamid(4), emoji: '\u{1F44D}' }))).toMatchObject(
      {
        kind: 'reaction',
        messageId: fixtureWamid(4),
        action: 'react',
        emoji: '\u{1F44D}',
        customerId: META_FIXTURE.userId,
      },
    );
    expect(only(whatsappReaction({ emoji: '' }))).toMatchObject({ action: 'unreact', emoji: null });
  });

  it('says a message of a type it cannot show is unsupported, with Meta’s reason', () => {
    expect(only(whatsappUnsupported())).toMatchObject({
      kind: 'unsupported',
      customerId: META_FIXTURE.userId,
      detail: 'Message type unknown',
      errors: [{ code: 131_051, title: 'Message type unknown', message: null }],
    });
  });

  it('reads a change of number as the old and new numbers', () => {
    expect(
      only(whatsappUserChangedNumber({ oldWaId: '16505551234', newWaId: '16505559876' })),
    ).toMatchObject({
      kind: 'user_changed_number',
      oldWaId: '16505551234',
      newWaId: '16505559876',
      customerId: META_FIXTURE.userId,
    });
  });

  it('ignores an empty text, and a system message that is not a change of number', () => {
    expect(only(whatsappText({ text: '' }))).toMatchObject({ kind: 'ignored', reason: 'empty' });

    const body = whatsappUserChangedNumber();
    const message = (
      body.entry as { changes: { value: { messages: { system: { type: string } }[] } }[] }[]
    )[0]?.changes[0]?.value.messages[0];
    if (message !== undefined) {
      message.system.type = 'user_identity_changed';
    }
    expect(only(body)).toMatchObject({
      kind: 'ignored',
      reason: 'system',
      detail: 'user_identity_changed',
    });
  });

  it('keeps the errors Meta attached to a message that is otherwise filed', () => {
    const body = whatsappImage();
    const message = (
      body.entry as { changes: { value: { messages: Record<string, unknown>[] } }[] }[]
    )[0]?.changes[0]?.value.messages[0];
    if (message !== undefined) {
      message.errors = [{ code: 131_052, title: 'Media download error', message: 'too large' }];
    }

    expect(messageOf(body).errors).toEqual([
      { code: 131_052, title: 'Media download error', message: 'too large' },
    ]);
  });

  it('turns a type it has no case for into an unsupported event, never an exception', () => {
    const body = whatsappText();
    const message = (
      body.entry as { changes: { value: { messages: Record<string, unknown>[] } }[] }[]
    )[0]?.changes[0]?.value.messages[0];
    if (message !== undefined) {
      message.type = 'order';
      delete message.text;
    }

    expect(only(body)).toMatchObject({ kind: 'unsupported', detail: 'order' });
  });

  it('keeps a button reply’s title as the text the customer chose', () => {
    const body = whatsappText();
    const message = (
      body.entry as { changes: { value: { messages: Record<string, unknown>[] } }[] }[]
    )[0]?.changes[0]?.value.messages[0];
    if (message !== undefined) {
      message.type = 'interactive';
      delete message.text;
      message.interactive = {
        type: 'button_reply',
        button_reply: { id: 'yes', title: 'Yes, please' },
      };
    }

    expect(messageOf(body).text).toBe('Yes, please');
  });
});

describe('WhatsApp statuses', () => {
  it.each(['sent', 'delivered', 'read'] as const)(
    'reads %s with the message it reports',
    (status) => {
      expect(
        only(whatsappStatus({ wamid: fixtureWamid(9), status, category: 'utility' })),
      ).toMatchObject({
        kind: 'status',
        messageId: fixtureWamid(9),
        status,
        pricingCategory: 'utility',
        customerId: META_FIXTURE.userId,
        errors: [],
      });
    },
  );

  it('reads a failure with Meta’s code and its words', () => {
    expect(
      only(whatsappStatus({ status: 'failed', errorCode: 131_049, errorTitle: 'Held back' })),
    ).toMatchObject({
      kind: 'status',
      status: 'failed',
      pricingCategory: null,
      errors: [{ code: 131_049, title: 'Held back', message: 'Held back' }],
    });
  });

  it('ignores a status Helpdock does not follow', () => {
    const body = whatsappStatus();
    const status = (
      body.entry as { changes: { value: { statuses: Record<string, unknown>[] } }[] }[]
    )[0]?.changes[0]?.value.statuses[0];
    if (status !== undefined) {
      status.status = 'deleted';
    }

    expect(only(body)).toMatchObject({ kind: 'ignored', reason: 'status', detail: 'deleted' });
  });
});

describe('a WhatsApp value that is not what it should be', () => {
  it('is one ignored event when the value has no metadata', () => {
    expect(classifyWhatsAppValue({ messages: [] })).toMatchObject([
      { kind: 'ignored', reason: 'malformed' },
    ]);
    expect(classifyWhatsAppValue('x')).toMatchObject([{ kind: 'ignored', reason: 'malformed' }]);
  });

  it('costs one message, not its neighbours', () => {
    const events = classifyWhatsAppValue({
      metadata: { phone_number_id: META_FIXTURE.phoneNumberId },
      contacts: [{ wa_id: '1', user_id: 'US.1' }],
      messages: [
        { id: fixtureWamid(1), from: '1', timestamp: '1', type: 'text', text: { body: 'good' } },
        { nothing: 'useful' },
        {
          id: fixtureWamid(3),
          from: '1',
          timestamp: '1',
          type: 'text',
          text: { body: 'also good' },
        },
      ],
    });

    expect(events.map((event) => event.kind)).toEqual(['message', 'ignored', 'message']);
  });

  it('reads an error about the account itself', () => {
    const events = classifyWhatsAppValue({
      metadata: { phone_number_id: META_FIXTURE.phoneNumberId },
      errors: [{ code: 131_031, title: 'Account locked' }],
    });

    expect(events).toMatchObject([
      { kind: 'error', errors: [{ code: 131_031, title: 'Account locked', message: null }] },
    ]);
  });

  it('ignores a message that names no customer', () => {
    const events = classifyWhatsAppValue({
      metadata: { phone_number_id: META_FIXTURE.phoneNumberId },
      contacts: [
        { wa_id: '1', user_id: 'US.1' },
        { wa_id: '2', user_id: 'US.2' },
      ],
      messages: [{ id: fixtureWamid(1), timestamp: '1', type: 'text', text: { body: 'who?' } }],
    });

    expect(events).toMatchObject([{ kind: 'ignored', reason: 'no-customer' }]);
  });
});

describe('Messenger events', () => {
  it('files a text from the page-scoped id, with what it answers', () => {
    expect(
      messageOf(pageText({ mid: fixtureMid(5), text: 'Hi', replyTo: fixtureMid(4) })),
    ).toMatchObject({
      platform: 'messenger',
      customerId: META_FIXTURE.psid,
      messageId: fixtureMid(5),
      text: 'Hi',
      quotedId: fixtureMid(4),
      waId: null,
      profileName: null,
      files: [],
    });
  });

  it('names an attachment by its CDN link and the type Messenger declared', () => {
    expect(
      messageOf(pageAttachment({ type: 'video', url: 'https://x.fbcdn.net/v.mp4' })).files,
    ).toEqual([{ kind: 'cdn_url', url: 'https://x.fbcdn.net/v.mp4', type: 'video' }]);
  });

  it('names a sticker as an attachment of its own type', () => {
    expect(messageOf(pageSticker()).files).toMatchObject([{ kind: 'cdn_url', type: 'sticker' }]);
  });

  it('files a fallback with a link as a link, and one without as unsupported', () => {
    expect(
      messageOf(pageFallback({ url: 'https://maps.example.com/x', title: 'Gate' })).links,
    ).toEqual([{ type: 'fallback', url: 'https://maps.example.com/x', title: 'Gate' }]);
    expect(only(pageFallback({ url: null }))).toMatchObject({
      kind: 'unsupported',
      detail: 'fallback',
    });
  });

  it('keeps an unsupported attachment beside the content that can be filed', () => {
    const body = pageText({ text: 'Look at this' });
    const message = (body.entry as { messaging: { message: Record<string, unknown> }[] }[])[0]
      ?.messaging[0]?.message;
    if (message !== undefined) {
      message.attachments = [{ type: 'template', payload: {} }];
    }

    expect(messageOf(body)).toMatchObject({
      text: 'Look at this',
      unsupportedAttachments: ['template'],
    });
  });

  it('files an echo against the customer it was sent to, with the app and the metadata', () => {
    expect(
      only(pageEcho({ appId: META_FIXTURE.appId, metadata: 'delivery-1', text: 'Sent' })),
    ).toMatchObject({
      kind: 'echo',
      customerId: META_FIXTURE.psid,
      appId: META_FIXTURE.appId,
      metadata: 'delivery-1',
      text: 'Sent',
    });
  });

  it('reads a delivery and a read as watermarks for the customer', () => {
    expect(only(pageDelivery({ watermark: 1_791_705_700, mids: [fixtureMid(1)] }))).toMatchObject({
      kind: 'delivery',
      customerId: META_FIXTURE.psid,
      watermark: new Date(1_791_705_700_000),
      mids: [fixtureMid(1)],
    });
    expect(only(pageDelivery())).toMatchObject({ kind: 'delivery', mids: [] });
    expect(only(pageRead({ watermark: 1_791_705_800 }))).toMatchObject({
      kind: 'read',
      customerId: META_FIXTURE.psid,
      watermark: new Date(1_791_705_800_000),
    });
  });

  it('reads a reaction, an edit and a postback against the customer', () => {
    expect(only(pageReaction({ mid: fixtureMid(2), action: 'unreact' }))).toMatchObject({
      kind: 'reaction',
      messageId: fixtureMid(2),
      action: 'unreact',
    });
    expect(only(pageEdit({ mid: fixtureMid(1), text: 'Fixed', numEdit: 2 }))).toMatchObject({
      kind: 'edit',
      messageId: fixtureMid(1),
      text: 'Fixed',
      editNumber: 2,
    });
    expect(only(pagePostback({ title: 'Get started', payload: 'GET_STARTED' }))).toMatchObject({
      kind: 'postback',
      title: 'Get started',
      payload: 'GET_STARTED',
    });
  });

  it('reads a referral and a policy enforcement notice', () => {
    const referral = classifyMessagingEvent(
      {
        sender: { id: '1' },
        recipient: { id: '2' },
        timestamp: 1,
        referral: { ref: 'ad-7', source: 'ADS' },
      },
      'messenger',
    );
    const policy = classifyMessagingEvent(
      {
        sender: { id: '2' },
        recipient: { id: '2' },
        timestamp: 1,
        'policy-enforcement': { action: 'block', reason: 'Spam' },
      },
      'messenger',
    );

    expect(referral).toMatchObject({ kind: 'referral', source: 'ADS' });
    expect(policy).toMatchObject({ kind: 'policy_enforcement', action: 'block', reason: 'Spam' });
  });

  it('puts an event on the standby channel aside, whatever it holds', () => {
    const body = {
      object: 'page',
      entry: [
        { id: META_FIXTURE.pageId, standby: [{ message: { mid: fixtureMid(1), text: 'x' } }] },
      ],
    };

    expect(eventsOf(body)).toMatchObject([{ kind: 'ignored', reason: 'standby' }]);
  });

  it('ignores an event of a kind it has no use for, and one it cannot read', () => {
    expect(
      classifyMessagingEvent(
        { sender: { id: '1' }, recipient: { id: '2' }, optin: { ref: 'x' } },
        'messenger',
      ),
    ).toMatchObject({ kind: 'ignored', reason: 'unknown-event' });
    expect(classifyMessagingEvent('nope', 'messenger')).toMatchObject({
      kind: 'ignored',
      reason: 'malformed',
    });
    expect(classifyMessagingEvent({ sender: 7 }, 'messenger')).toMatchObject({
      kind: 'ignored',
      reason: 'malformed',
    });
    expect(
      classifyMessagingEvent({ sender: { id: '1' }, message: { text: 'no mid' } }, 'messenger'),
    ).toMatchObject({ kind: 'ignored', reason: 'malformed' });
  });
});

describe('Instagram events', () => {
  it('files a text from the Instagram-scoped id', () => {
    expect(messageOf(instagramText({ text: 'Hi' }))).toMatchObject({
      platform: 'instagram',
      customerId: META_FIXTURE.igsid,
      text: 'Hi',
    });
  });

  it('names an attachment by its link', () => {
    expect(messageOf(instagramAttachment({ type: 'video' })).files).toMatchObject([
      { kind: 'cdn_url', type: 'video' },
    ]);
    expect(
      messageOf(instagramAttachment({ type: 'ig_reel', url: 'https://www.instagram.com/reel/x' }))
        .links,
    ).toEqual([{ type: 'ig_reel', url: 'https://www.instagram.com/reel/x', title: null }]);
  });

  it('files a story reply with the story named and its media to fetch', () => {
    const event = messageOf(instagramStoryReply({ storyId: '180', url: 'https://x.fbsbx.com/s' }));

    expect(event.text).toBe('Love this one!');
    expect(event.story).toEqual({ kind: 'reply', id: '180', url: 'https://x.fbsbx.com/s' });
    expect(event.files).toEqual([{ kind: 'cdn_url', url: 'https://x.fbsbx.com/s', type: 'story' }]);
  });

  it('files a story mention as its media with the story named, and no text', () => {
    const event = messageOf(instagramStoryMention({ url: 'https://x.fbsbx.com/m' }));

    expect(event.text).toBe('');
    expect(event.story).toEqual({ kind: 'mention', id: null, url: 'https://x.fbsbx.com/m' });
    expect(event.files).toEqual([
      { kind: 'cdn_url', url: 'https://x.fbsbx.com/m', type: 'story_mention' },
    ]);
  });

  it('reads an echo inside messages, an unsent message and an unsupported one', () => {
    expect(only(instagramEcho())).toMatchObject({
      kind: 'echo',
      customerId: META_FIXTURE.igsid,
      appId: null,
    });
    expect(only(instagramDeleted({ mid: fixtureMid(8) }))).toMatchObject({
      kind: 'deleted',
      customerId: META_FIXTURE.igsid,
      messageId: fixtureMid(8),
    });
    expect(only(instagramUnsupported())).toMatchObject({ kind: 'unsupported' });
  });

  it('reads a seen report as one message, where Messenger’s read is a watermark', () => {
    expect(only(instagramSeen({ mid: fixtureMid(6) }))).toMatchObject({
      kind: 'seen',
      customerId: META_FIXTURE.igsid,
      messageId: fixtureMid(6),
    });
  });

  it('reads a reaction', () => {
    expect(only(instagramReaction({ mid: fixtureMid(2), emoji: '\u{1F602}' }))).toMatchObject({
      kind: 'reaction',
      action: 'react',
      emoji: '\u{1F602}',
    });
  });
});

describe('routeEnvelope', () => {
  it('routes WhatsApp by the number a change is about, not by the business account', () => {
    const first = whatsappText({ phoneNumberId: '111', wamid: fixtureWamid(1) });
    const second = whatsappText({ phoneNumberId: '222', wamid: fixtureWamid(2) });
    const envelope = metaEnvelopeSchema.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: META_FIXTURE.wabaId,
          changes: [
            ...((first.entry as { changes: unknown[] }[])[0]?.changes ?? []),
            ...((second.entry as { changes: unknown[] }[])[0]?.changes ?? []),
          ],
        },
      ],
    });

    const { routes } = routeEnvelope(envelope);

    expect(routes.map((route) => [route.platform, route.externalId, route.wabaId])).toEqual([
      ['whatsapp', '111', META_FIXTURE.wabaId],
      ['whatsapp', '222', META_FIXTURE.wabaId],
    ]);
  });

  it('routes Messenger and Instagram by the entry, keeping events in the order Meta sent them', () => {
    const envelope = metaEnvelopeSchema.parse({
      object: 'page',
      entry: [
        {
          id: 'P1',
          messaging: [
            {
              sender: { id: 'u' },
              recipient: { id: 'P1' },
              timestamp: 1,
              message: { mid: fixtureMid(1), text: 'a' },
            },
          ],
        },
        {
          id: 'P1',
          messaging: [
            {
              sender: { id: 'u' },
              recipient: { id: 'P1' },
              timestamp: 2,
              message: { mid: fixtureMid(2), text: 'b' },
            },
          ],
        },
        {
          id: 'P2',
          messaging: [
            {
              sender: { id: 'v' },
              recipient: { id: 'P2' },
              timestamp: 3,
              message: { mid: fixtureMid(3), text: 'c' },
            },
          ],
        },
      ],
    });

    const { routes } = routeEnvelope(envelope);

    expect(routes.map((route) => [route.externalId, route.wabaId])).toEqual([
      ['P1', null],
      ['P2', null],
    ]);
    expect(routes[0]?.events.map((event) => event.kind === 'message' && event.text)).toEqual([
      'a',
      'b',
    ]);
  });

  it('files two accounts of one batch under two routes', () => {
    const envelope = metaEnvelopeSchema.parse({
      object: 'instagram',
      entry: [
        ...((instagramText({ igAccountId: '1', mid: fixtureMid(1) }).entry as unknown[]) ?? []),
        ...((instagramText({ igAccountId: '2', mid: fixtureMid(2) }).entry as unknown[]) ?? []),
      ],
    });

    expect(routeEnvelope(envelope).routes.map((route) => route.externalId)).toEqual(['1', '2']);
  });

  it('sets aside a WhatsApp field that is not messages, and one it cannot route', () => {
    const envelope = metaEnvelopeSchema.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: META_FIXTURE.wabaId,
          changes: [
            { field: 'account_update', value: { event: 'VERIFIED_ACCOUNT' } },
            { field: 'messages', value: { messages: [] } },
          ],
        },
      ],
    });

    expect(routeEnvelope(envelope)).toEqual({
      routes: [],
      unrouted: [
        { platform: 'whatsapp', field: 'account_update', reason: 'field' },
        { platform: 'whatsapp', field: 'messages', reason: 'malformed' },
      ],
    });
  });

  it('counts an Instagram change as an ignored field rather than a message', () => {
    const envelope = metaEnvelopeSchema.parse({
      object: 'instagram',
      entry: [{ id: META_FIXTURE.igAccountId, changes: [{ field: 'comments', value: {} }] }],
    });

    expect(routeEnvelope(envelope).routes[0]?.events).toMatchObject([
      { kind: 'ignored', reason: 'field' },
    ]);
  });
});

describe('metaExternalId and metaIdentityValue', () => {
  it('keeps the id Meta gave a message as its dedupe key, on every platform', () => {
    expect(metaExternalId('whatsapp', fixtureWamid(1))).toBe(fixtureWamid(1));
    expect(metaExternalId('messenger', fixtureMid(1))).toBe(fixtureMid(1));
    expect(metaExternalId('instagram', fixtureMid(1))).toBe(fixtureMid(1));
  });

  it('stores the WhatsApp user id alone and the others beside their account (DOMAIN-RULES §4.7)', () => {
    expect(metaIdentityValue('whatsapp', META_FIXTURE.phoneNumberId, META_FIXTURE.userId)).toBe(
      META_FIXTURE.userId,
    );
    expect(metaIdentityValue('messenger', '112', '765')).toBe('112:765');
    expect(metaIdentityValue('instagram', '178', '179')).toBe('178:179');
  });
});
