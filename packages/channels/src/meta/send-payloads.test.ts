import { describe, expect, it } from 'vitest';
import {
  messagingSendPayloadSchema,
  sendPayloadText,
  whatsappSendPayloadSchema,
} from './send-payloads.js';

const waText = {
  messaging_product: 'whatsapp',
  to: '16505551234',
  type: 'text',
  text: { body: 'Hello' },
};

describe('whatsappSendPayloadSchema', () => {
  it('accepts a text to a number, to a user id, and one that quotes a message', () => {
    expect(whatsappSendPayloadSchema.safeParse(waText).success).toBe(true);
    expect(
      whatsappSendPayloadSchema.safeParse({
        ...waText,
        to: undefined,
        recipient: 'US.13491208655302741918',
      }).success,
    ).toBe(true);
    expect(
      whatsappSendPayloadSchema.safeParse({ ...waText, context: { message_id: 'wamid.X' } })
        .success,
    ).toBe(true);
  });

  it.each(['image', 'audio', 'video', 'document', 'sticker'] as const)(
    'accepts a %s by uploaded media id, with a caption where WhatsApp allows one',
    (type) => {
      expect(
        whatsappSendPayloadSchema.safeParse({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '16505551234',
          type,
          [type]: { id: '1479537139650973', caption: 'Look' },
        }).success,
      ).toBe(true);
    },
  );

  it('accepts a document by https link with a file name, and refuses a link that is not https', () => {
    const payload = (link: string) => ({
      messaging_product: 'whatsapp',
      to: '16505551234',
      type: 'document',
      document: { link, filename: 'invoice.pdf' },
    });

    expect(
      whatsappSendPayloadSchema.safeParse(payload('https://files.example.com/invoice.pdf')).success,
    ).toBe(true);
    expect(
      whatsappSendPayloadSchema.safeParse(payload('http://files.example.com/invoice.pdf')).success,
    ).toBe(false);
  });

  it.each([
    ['no recipient', { ...waText, to: undefined }],
    ['an empty text', { ...waText, text: { body: '' } }],
    ['a field it did not mean to send', { ...waText, surprise: 1 }],
    ['another messaging product', { ...waText, messaging_product: 'telegram' }],
    ['a type it does not send', { ...waText, type: 'contacts' }],
    [
      'a media object with neither an id nor a link',
      {
        messaging_product: 'whatsapp',
        to: '1',
        type: 'image',
        image: { caption: 'x' },
      },
    ],
    [
      'a media type whose object is missing',
      { messaging_product: 'whatsapp', to: '1', type: 'image' },
    ],
  ])('refuses %s', (_label, payload) => {
    expect(whatsappSendPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('messagingSendPayloadSchema', () => {
  const text = {
    recipient: { id: '7654321098765432' },
    messaging_type: 'RESPONSE',
    message: { text: 'Hi' },
  };

  it('accepts a text with the delivery id as metadata, so an echo can be told from a person’s', () => {
    expect(
      messagingSendPayloadSchema.safeParse({
        ...text,
        message: { text: 'Hi', metadata: '0192c3f0-delivery' },
      }).success,
    ).toBe(true);
  });

  it.each(['image', 'audio', 'video', 'file'] as const)(
    'accepts a %s attachment by URL',
    (type) => {
      expect(
        messagingSendPayloadSchema.safeParse({
          recipient: { id: '1' },
          messaging_type: 'RESPONSE',
          message: {
            attachment: {
              type,
              payload: { url: 'https://files.example.com/a?sig=1', is_reusable: false },
            },
          },
        }).success,
      ).toBe(true);
    },
  );

  it('accepts an attachment by the id an upload returned', () => {
    expect(
      messagingSendPayloadSchema.safeParse({
        recipient: { id: '1' },
        message: { attachment: { type: 'image', payload: { attachment_id: '9988' } } },
      }).success,
    ).toBe(true);
  });

  it('accepts HUMAN_AGENT only as a message tag, as M10-09 sends it', () => {
    expect(
      messagingSendPayloadSchema.safeParse({
        ...text,
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
      }).success,
    ).toBe(true);
    expect(messagingSendPayloadSchema.safeParse({ ...text, tag: 'HUMAN_AGENT' }).success).toBe(
      false,
    );
    expect(
      messagingSendPayloadSchema.safeParse({ ...text, messaging_type: 'MESSAGE_TAG' }).success,
    ).toBe(false);
    expect(
      messagingSendPayloadSchema.safeParse({
        ...text,
        messaging_type: 'MESSAGE_TAG',
        tag: 'ACCOUNT_UPDATE',
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'text and an attachment together',
      {
        recipient: { id: '1' },
        message: { text: 'x', attachment: { type: 'image', payload: { url: 'https://x.test/a' } } },
      },
    ],
    ['nothing to say', { recipient: { id: '1' }, message: {} }],
    ['no recipient', { message: { text: 'x' } }],
    ['an empty recipient', { recipient: { id: '' }, message: { text: 'x' } }],
    [
      'an attachment type Messenger lacks',
      {
        recipient: { id: '1' },
        message: { attachment: { type: 'sticker', payload: { url: 'https://x.test/a' } } },
      },
    ],
    [
      'an attachment URL that is not a URL',
      { recipient: { id: '1' }, message: { attachment: { type: 'image', payload: { url: 'a' } } } },
    ],
    ['a field it did not mean to send', { ...text, surprise: true }],
  ])('refuses %s', (_label, payload) => {
    expect(messagingSendPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe('sendPayloadText', () => {
  it('reads the text of either shape, and null for a file', () => {
    expect(sendPayloadText(whatsappSendPayloadSchema.parse(waText))).toBe('Hello');
    expect(
      sendPayloadText(
        messagingSendPayloadSchema.parse({ recipient: { id: '1' }, message: { text: 'Hi' } }),
      ),
    ).toBe('Hi');
    expect(
      sendPayloadText(
        whatsappSendPayloadSchema.parse({
          messaging_product: 'whatsapp',
          to: '1',
          type: 'image',
          image: { id: '5' },
        }),
      ),
    ).toBeNull();
    expect(
      sendPayloadText(
        messagingSendPayloadSchema.parse({
          recipient: { id: '1' },
          message: { attachment: { type: 'image', payload: { attachment_id: '5' } } },
        }),
      ),
    ).toBeNull();
  });
});
