import { createHash } from 'node:crypto';
import type { MetaPlatform } from '@helpdock/schemas';
import { DEFAULT_META_GRAPH_VERSION } from './graph-client.js';

/**
 * Webhook bodies and Graph answers as Meta writes them, pinned to
 * {@link DEFAULT_META_GRAPH_VERSION} (M10-01), for every suite that stands a
 * stand-in for Meta (`testing/fake-graph.ts`). Built rather than checked in as
 * JSON so a reader can see which field a test cares about and which is
 * scenery; `envelope.test.ts` runs every one through the schema and the
 * classifier, so a fixture that drifts from the shapes Helpdock reads fails
 * there first.
 *
 * Every field has a default, so `whatsappText({ text: 'Hello' })` is a message
 * from the same customer to the same number every time. A test that posts two
 * messages passes each its own `wamid` or `mid`, because the dedupe key is the
 * whole point of those two ids.
 *
 * Bumping `META_GRAPH_VERSION` means rereading Meta's changelog for these
 * shapes first (docs/guides/configuration.md).
 */

/** The ids and the clock every fixture falls back on. */
export const META_FIXTURE = {
  version: DEFAULT_META_GRAPH_VERSION,
  appId: '1234567890123456',
  wabaId: '102290129340398',
  phoneNumberId: '106540352242922',
  displayPhone: '15550783881',
  waId: '16505551234',
  userId: 'US.13491208655302741918',
  profileName: 'Sheena Nelson',
  pageId: '112233445566778',
  psid: '7654321098765432',
  igAccountId: '17841400000000000',
  igsid: '17841499999999999',
  /** Seconds: 2026-10-11T08:00:00Z. */
  time: 1_791_705_600,
} as const;

/** A webhook body, ready for `JSON.stringify` and a signature. */
export type MetaWebhookBody = Record<string, unknown>;

const seconds = (value: number | undefined): number => value ?? META_FIXTURE.time;
const millis = (value: number | undefined): number => seconds(value) * 1_000;

/** `wamid.` plus a base64-ish run, as WhatsApp writes its ids. Distinct per `n`. */
export const fixtureWamid = (n: number): string =>
  `wamid.HBgLMTY1MDU1NTEyMzQVAgASGBQz${String(n).padStart(8, '0')}`;

/** `m_` plus a run, as Messenger and Instagram write theirs. Distinct per `n`. */
export const fixtureMid = (n: number): string =>
  `m_AbCdEfGhIjKlMnOpQrStUvWxYz${String(n).padStart(8, '0')}`;

/** The base64 SHA-256 a WhatsApp webhook carries beside a media id. */
export const sha256Base64 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('base64');

/** The hex SHA-256 `GET /{media-id}` answers with. */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

// --------------------------------------------------------------------------
// WhatsApp
// --------------------------------------------------------------------------

interface WhatsAppBase {
  readonly wabaId?: string;
  readonly phoneNumberId?: string;
  readonly displayPhone?: string;
  /** The customer's number in digits. */
  readonly from?: string;
  /** The business-scoped user id. */
  readonly userId?: string;
  readonly profileName?: string;
  readonly wamid?: string;
  /** Seconds. */
  readonly timestamp?: number;
}

interface WhatsAppValue {
  readonly contacts?: readonly Record<string, unknown>[];
  readonly messages?: readonly Record<string, unknown>[];
  readonly statuses?: readonly Record<string, unknown>[];
  readonly errors?: readonly Record<string, unknown>[];
}

const whatsappEnvelope = (base: WhatsAppBase, value: WhatsAppValue): MetaWebhookBody => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: base.wabaId ?? META_FIXTURE.wabaId,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: base.displayPhone ?? META_FIXTURE.displayPhone,
              phone_number_id: base.phoneNumberId ?? META_FIXTURE.phoneNumberId,
            },
            ...value,
          },
        },
      ],
    },
  ],
});

const whatsappContact = (base: WhatsAppBase): Record<string, unknown> => ({
  profile: { name: base.profileName ?? META_FIXTURE.profileName },
  wa_id: base.from ?? META_FIXTURE.waId,
  user_id: base.userId ?? META_FIXTURE.userId,
});

/** A message of `type` from the customer, with the fields every WhatsApp message has. */
const whatsappMessage = (
  base: WhatsAppBase,
  type: string,
  body: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): MetaWebhookBody =>
  whatsappEnvelope(base, {
    contacts: [whatsappContact(base)],
    messages: [
      {
        from: base.from ?? META_FIXTURE.waId,
        id: base.wamid ?? fixtureWamid(1),
        timestamp: String(seconds(base.timestamp)),
        type,
        ...body,
        ...extra,
      },
    ],
  });

export interface WhatsAppTextInput extends WhatsAppBase {
  readonly text?: string;
  /** The `wamid` this message quotes. */
  readonly quotes?: string;
  readonly forwarded?: boolean;
}

export const whatsappText = (input: WhatsAppTextInput = {}): MetaWebhookBody =>
  whatsappMessage(
    input,
    'text',
    { text: { body: input.text ?? 'Does it come in another color?' } },
    input.quotes === undefined && input.forwarded !== true
      ? {}
      : {
          context: {
            ...(input.quotes === undefined
              ? {}
              : { from: META_FIXTURE.displayPhone, id: input.quotes }),
            ...(input.forwarded === true ? { forwarded: true } : {}),
          },
        },
  );

export interface WhatsAppMediaInput extends WhatsAppBase {
  readonly mediaId?: string;
  readonly mimeType?: string;
  /** Base64, as the webhook carries it; see {@link sha256Base64}. */
  readonly sha256?: string;
  readonly caption?: string;
}

const mediaObject = (input: WhatsAppMediaInput, mimeType: string): Record<string, unknown> => ({
  id: input.mediaId ?? '1479537139650973',
  mime_type: input.mimeType ?? mimeType,
  sha256: input.sha256 ?? 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
  ...(input.caption === undefined ? {} : { caption: input.caption }),
});

export const whatsappImage = (input: WhatsAppMediaInput = {}): MetaWebhookBody =>
  whatsappMessage(input, 'image', { image: mediaObject(input, 'image/jpeg') });

export interface WhatsAppAudioInput extends WhatsAppMediaInput {
  /** False for an audio file the customer attached rather than a voice note. */
  readonly voice?: boolean;
}

export const whatsappAudioVoice = (input: WhatsAppAudioInput = {}): MetaWebhookBody =>
  whatsappMessage(input, 'audio', {
    audio: { ...mediaObject(input, 'audio/ogg; codecs=opus'), voice: input.voice ?? true },
  });

export interface WhatsAppDocumentInput extends WhatsAppMediaInput {
  readonly filename?: string;
}

export const whatsappDocument = (input: WhatsAppDocumentInput = {}): MetaWebhookBody =>
  whatsappMessage(input, 'document', {
    document: {
      ...mediaObject(input, 'application/pdf'),
      filename: input.filename ?? 'invoice-1042.pdf',
    },
  });

export const whatsappSticker = (input: WhatsAppMediaInput = {}): MetaWebhookBody =>
  whatsappMessage(input, 'sticker', {
    sticker: { ...mediaObject(input, 'image/webp'), animated: false },
  });

export interface WhatsAppLocationInput extends WhatsAppBase {
  readonly latitude?: number;
  readonly longitude?: number;
  readonly name?: string;
  readonly address?: string;
}

export const whatsappLocation = (input: WhatsAppLocationInput = {}): MetaWebhookBody =>
  whatsappMessage(input, 'location', {
    location: {
      latitude: input.latitude ?? 52.52,
      longitude: input.longitude ?? 13.405,
      name: input.name ?? 'Brandenburg Gate',
      address: input.address ?? 'Pariser Platz, 10117 Berlin',
    },
  });

export const whatsappContacts = (input: WhatsAppBase = {}): MetaWebhookBody =>
  whatsappMessage(input, 'contacts', {
    contacts: [
      {
        name: { formatted_name: 'Mona Khalil', first_name: 'Mona', last_name: 'Khalil' },
        org: { company: 'Khalil Trading' },
        phones: [{ phone: '+963 931 234 567', wa_id: '963931234567', type: 'CELL' }],
        emails: [{ email: 'mona@example.com', type: 'WORK' }],
      },
    ],
  });

export const whatsappReaction = (
  input: WhatsAppBase & { readonly reactsTo?: string; readonly emoji?: string } = {},
): MetaWebhookBody =>
  whatsappMessage(input, 'reaction', {
    reaction: { message_id: input.reactsTo ?? fixtureWamid(99), emoji: input.emoji ?? '\u{1F44D}' },
  });

export interface WhatsAppStatusInput extends WhatsAppBase {
  readonly status?: 'sent' | 'delivered' | 'read' | 'failed';
  /** The customer's number, as `recipient_id`. */
  readonly recipientId?: string;
  readonly category?: 'service' | 'utility' | 'marketing' | 'authentication';
  readonly errorCode?: number;
  readonly errorTitle?: string;
}

/** A report on a message Helpdock sent: `sent`, `delivered`, `read` or `failed`. */
export const whatsappStatus = (input: WhatsAppStatusInput = {}): MetaWebhookBody =>
  whatsappEnvelope(input, {
    statuses: [
      {
        id: input.wamid ?? fixtureWamid(1),
        status: input.status ?? 'delivered',
        timestamp: String(seconds(input.timestamp)),
        recipient_id: input.recipientId ?? input.from ?? META_FIXTURE.waId,
        recipient_user_id: input.userId ?? META_FIXTURE.userId,
        ...(input.status === 'failed'
          ? {
              errors: [
                {
                  code: input.errorCode ?? 131_026,
                  title: input.errorTitle ?? 'Message undeliverable',
                  message: input.errorTitle ?? 'Message undeliverable',
                  error_data: { details: input.errorTitle ?? 'Message undeliverable' },
                },
              ],
            }
          : {
              pricing: {
                billable: true,
                pricing_model: 'PMP',
                type: 'regular',
                category: input.category ?? 'service',
              },
            }),
      },
    ],
  });

/** Something WhatsApp sends that carries no content: an edit, a poll. */
export const whatsappUnsupported = (input: WhatsAppBase = {}): MetaWebhookBody =>
  whatsappMessage(
    input,
    'unsupported',
    { unsupported: { type: 'edit' } },
    { errors: [{ code: 131_051, title: 'Message type unknown' }] },
  );

export interface WhatsAppChangedNumberInput extends WhatsAppBase {
  readonly oldWaId?: string;
  readonly newWaId?: string;
}

export const whatsappUserChangedNumber = (
  input: WhatsAppChangedNumberInput = {},
): MetaWebhookBody => {
  const oldWaId = input.oldWaId ?? META_FIXTURE.waId;
  const newWaId = input.newWaId ?? '16505559876';

  return whatsappMessage({ ...input, from: input.from ?? oldWaId }, 'system', {
    system: {
      type: 'user_changed_number',
      body: `User ${oldWaId} changed from ${oldWaId} to ${newWaId}`,
      wa_id: newWaId,
      customer: oldWaId,
    },
  });
};

/**
 * A customer who adopted a WhatsApp username and withheld their number: no
 * `from`, no `wa_id`, a user id and a username (DOMAIN-RULES §4.7).
 */
export const whatsappNoWaId = (
  input: WhatsAppBase & { readonly text?: string; readonly username?: string } = {},
): MetaWebhookBody =>
  whatsappEnvelope(input, {
    contacts: [
      {
        profile: { name: input.profileName ?? META_FIXTURE.profileName },
        user_id: input.userId ?? META_FIXTURE.userId,
        username: input.username ?? 'sheena.nelson',
      },
    ],
    messages: [
      {
        from_user_id: input.userId ?? META_FIXTURE.userId,
        id: input.wamid ?? fixtureWamid(1),
        timestamp: String(seconds(input.timestamp)),
        type: 'text',
        text: { body: input.text ?? 'Hello from a username' },
      },
    ],
  });

// --------------------------------------------------------------------------
// Messenger
// --------------------------------------------------------------------------

interface MessagingBase {
  readonly pageId?: string;
  readonly psid?: string;
  /** Seconds since the epoch; the fixture writes milliseconds, as Messenger does. */
  readonly timestamp?: number;
}

const pageEnvelope = (base: MessagingBase, event: Record<string, unknown>): MetaWebhookBody => ({
  object: 'page',
  entry: [
    {
      id: base.pageId ?? META_FIXTURE.pageId,
      time: millis(base.timestamp),
      messaging: [{ timestamp: millis(base.timestamp), ...event }],
    },
  ],
});

/** A customer's message: sender is the customer, recipient the Page. */
const pageMessage = (base: MessagingBase, message: Record<string, unknown>): MetaWebhookBody =>
  pageEnvelope(base, {
    sender: { id: base.psid ?? META_FIXTURE.psid },
    recipient: { id: base.pageId ?? META_FIXTURE.pageId },
    message,
  });

export interface PageTextInput extends MessagingBase {
  readonly mid?: string;
  readonly text?: string;
  /** The `mid` this message answers. */
  readonly replyTo?: string;
}

export const pageText = (input: PageTextInput = {}): MetaWebhookBody =>
  pageMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    text: input.text ?? 'Hello, is anyone there?',
    ...(input.replyTo === undefined ? {} : { reply_to: { mid: input.replyTo } }),
  });

export interface PageAttachmentInput extends MessagingBase {
  readonly mid?: string;
  readonly type?: 'image' | 'video' | 'audio' | 'file';
  readonly url?: string;
  readonly text?: string;
}

export const pageAttachment = (input: PageAttachmentInput = {}): MetaWebhookBody =>
  pageMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    ...(input.text === undefined ? {} : { text: input.text }),
    attachments: [
      {
        type: input.type ?? 'image',
        payload: {
          url: input.url ?? 'https://scontent.xx.fbcdn.net/v/t1.15752-9/photo-1.jpg?oh=00&oe=00',
        },
      },
    ],
  });

export interface PageEchoInput extends MessagingBase {
  readonly mid?: string;
  readonly text?: string;
  readonly appId?: string;
  /** What Helpdock put in `metadata` on the send: a delivery id. */
  readonly metadata?: string;
}

/** A message the Page sent, echoed back: sender is the Page, recipient the customer. */
export const pageEcho = (input: PageEchoInput = {}): MetaWebhookBody =>
  pageEnvelope(input, {
    sender: { id: input.pageId ?? META_FIXTURE.pageId },
    recipient: { id: input.psid ?? META_FIXTURE.psid },
    message: {
      is_echo: true,
      app_id: Number(input.appId ?? META_FIXTURE.appId),
      mid: input.mid ?? fixtureMid(2),
      text: input.text ?? 'Thanks for writing in.',
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });

export interface PageWatermarkInput extends MessagingBase {
  readonly watermark?: number;
}

/** Messenger: everything to this customer before the watermark has arrived. */
export const pageDelivery = (
  input: PageWatermarkInput & { readonly mids?: readonly string[] } = {},
): MetaWebhookBody =>
  pageEnvelope(input, {
    sender: { id: input.psid ?? META_FIXTURE.psid },
    recipient: { id: input.pageId ?? META_FIXTURE.pageId },
    delivery: {
      ...(input.mids === undefined ? {} : { mids: input.mids }),
      watermark: millis(input.watermark),
    },
  });

/** Messenger: everything to this customer before the watermark has been read. */
export const pageRead = (input: PageWatermarkInput = {}): MetaWebhookBody =>
  pageEnvelope(input, {
    sender: { id: input.psid ?? META_FIXTURE.psid },
    recipient: { id: input.pageId ?? META_FIXTURE.pageId },
    read: { watermark: millis(input.watermark) },
  });

export const pageReaction = (
  input: MessagingBase & {
    readonly mid?: string;
    readonly action?: 'react' | 'unreact';
    readonly emoji?: string;
  } = {},
): MetaWebhookBody =>
  pageEnvelope(input, {
    sender: { id: input.psid ?? META_FIXTURE.psid },
    recipient: { id: input.pageId ?? META_FIXTURE.pageId },
    reaction: {
      mid: input.mid ?? fixtureMid(2),
      action: input.action ?? 'react',
      reaction: 'love',
      emoji: input.emoji ?? '❤️',
    },
  });

export const pageEdit = (
  input: MessagingBase & {
    readonly mid?: string;
    readonly text?: string;
    readonly numEdit?: number;
  } = {},
): MetaWebhookBody =>
  pageEnvelope(input, {
    sender: { id: input.psid ?? META_FIXTURE.psid },
    recipient: { id: input.pageId ?? META_FIXTURE.pageId },
    message_edit: {
      mid: input.mid ?? fixtureMid(1),
      text: input.text ?? 'Hello, is anyone there? (edited)',
      num_edit: input.numEdit ?? 1,
    },
  });

export const pagePostback = (
  input: MessagingBase & { readonly title?: string; readonly payload?: string } = {},
): MetaWebhookBody =>
  pageEnvelope(input, {
    sender: { id: input.psid ?? META_FIXTURE.psid },
    recipient: { id: input.pageId ?? META_FIXTURE.pageId },
    postback: {
      mid: fixtureMid(3),
      title: input.title ?? 'Get started',
      payload: input.payload ?? 'GET_STARTED',
    },
  });

/** A sticker, which Messenger sends as an attachment with a sticker id. */
export const pageSticker = (
  input: MessagingBase & { readonly mid?: string; readonly url?: string } = {},
): MetaWebhookBody =>
  pageMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    attachments: [
      {
        type: 'sticker',
        payload: {
          url:
            input.url ?? 'https://scontent.xx.fbcdn.net/v/t39.1997-6/sticker-369239263222822.png',
          sticker_id: 369_239_263_222_822,
        },
      },
    ],
  });

/**
 * A link Messenger could not render as media: `fallback`, with a URL when the
 * customer shared one and none when it was something else.
 */
export const pageFallback = (
  input: MessagingBase & {
    readonly mid?: string;
    readonly url?: string | null;
    readonly title?: string;
  } = {},
): MetaWebhookBody =>
  pageMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    attachments: [
      {
        type: 'fallback',
        title: input.title ?? 'Brandenburg Gate',
        ...(input.url === null
          ? {}
          : { url: input.url ?? 'https://maps.example.com/?q=52.52,13.405' }),
        payload: null,
      },
    ],
  });

// --------------------------------------------------------------------------
// Instagram
// --------------------------------------------------------------------------

interface InstagramBase {
  readonly igAccountId?: string;
  readonly igsid?: string;
  readonly timestamp?: number;
}

const instagramEnvelope = (
  base: InstagramBase,
  event: Record<string, unknown>,
): MetaWebhookBody => ({
  object: 'instagram',
  entry: [
    {
      id: base.igAccountId ?? META_FIXTURE.igAccountId,
      time: millis(base.timestamp),
      messaging: [{ timestamp: millis(base.timestamp), ...event }],
    },
  ],
});

const instagramMessage = (base: InstagramBase, message: Record<string, unknown>): MetaWebhookBody =>
  instagramEnvelope(base, {
    sender: { id: base.igsid ?? META_FIXTURE.igsid },
    recipient: { id: base.igAccountId ?? META_FIXTURE.igAccountId },
    message,
  });

export interface InstagramTextInput extends InstagramBase {
  readonly mid?: string;
  readonly text?: string;
  readonly replyTo?: string;
}

export const instagramText = (input: InstagramTextInput = {}): MetaWebhookBody =>
  instagramMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    text: input.text ?? 'Hi! Do you ship to Dubai?',
    ...(input.replyTo === undefined ? {} : { reply_to: { mid: input.replyTo } }),
  });

export interface InstagramAttachmentInput extends InstagramBase {
  readonly mid?: string;
  readonly type?: 'image' | 'video' | 'audio' | 'file' | 'share' | 'ig_reel' | 'ig_post';
  readonly url?: string;
  readonly text?: string;
}

export const instagramAttachment = (input: InstagramAttachmentInput = {}): MetaWebhookBody =>
  instagramMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    ...(input.text === undefined ? {} : { text: input.text }),
    attachments: [
      {
        type: input.type ?? 'image',
        payload: {
          url: input.url ?? 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x',
        },
      },
    ],
  });

export interface InstagramStoryInput extends InstagramBase {
  readonly mid?: string;
  readonly text?: string;
  readonly storyId?: string;
  readonly url?: string;
}

/** A customer's reply to one of the account's stories. */
export const instagramStoryReply = (input: InstagramStoryInput = {}): MetaWebhookBody =>
  instagramMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    text: input.text ?? 'Love this one!',
    reply_to: {
      story: {
        id: input.storyId ?? '18012345678901234',
        url: input.url ?? 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2&signature=y',
      },
    },
  });

/** A customer mentioning the account in their own story; the media expires with it. */
export const instagramStoryMention = (input: InstagramStoryInput = {}): MetaWebhookBody =>
  instagramMessage(input, {
    mid: input.mid ?? fixtureMid(1),
    attachments: [
      {
        type: 'story_mention',
        payload: {
          url: input.url ?? 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=3&signature=z',
        },
      },
    ],
  });

/** A message typed in the Instagram app by the business, echoed inside `messages`. */
export const instagramEcho = (
  input: InstagramBase & { readonly mid?: string; readonly text?: string } = {},
): MetaWebhookBody =>
  instagramEnvelope(input, {
    sender: { id: input.igAccountId ?? META_FIXTURE.igAccountId },
    recipient: { id: input.igsid ?? META_FIXTURE.igsid },
    message: {
      is_echo: true,
      mid: input.mid ?? fixtureMid(2),
      text: input.text ?? 'Yes, we ship worldwide.',
    },
  });

/** The customer unsent a message. */
export const instagramDeleted = (
  input: InstagramBase & { readonly mid?: string } = {},
): MetaWebhookBody =>
  instagramMessage(input, { mid: input.mid ?? fixtureMid(1), is_deleted: true });

/** Something Instagram flags as unsupported, such as a poll answer. */
export const instagramUnsupported = (
  input: InstagramBase & { readonly mid?: string } = {},
): MetaWebhookBody =>
  instagramMessage(input, { mid: input.mid ?? fixtureMid(1), is_unsupported: true });

/** Instagram: one message has been seen. */
export const instagramSeen = (
  input: InstagramBase & { readonly mid?: string } = {},
): MetaWebhookBody =>
  instagramEnvelope(input, {
    sender: { id: input.igsid ?? META_FIXTURE.igsid },
    recipient: { id: input.igAccountId ?? META_FIXTURE.igAccountId },
    read: { mid: input.mid ?? fixtureMid(2) },
  });

export const instagramReaction = (
  input: InstagramBase & {
    readonly mid?: string;
    readonly action?: 'react' | 'unreact';
    readonly emoji?: string;
  } = {},
): MetaWebhookBody =>
  instagramEnvelope(input, {
    sender: { id: input.igsid ?? META_FIXTURE.igsid },
    recipient: { id: input.igAccountId ?? META_FIXTURE.igAccountId },
    reaction: {
      mid: input.mid ?? fixtureMid(2),
      action: input.action ?? 'react',
      reaction: 'love',
      emoji: input.emoji ?? '❤️',
    },
  });

// --------------------------------------------------------------------------
// What Graph answers
// --------------------------------------------------------------------------

/** What a refused call answers with, whichever platform sent it. */
interface GraphErrorBody {
  readonly error: Record<string, unknown>;
}

const graphError = (
  code: number,
  message: string,
  extra: Record<string, unknown> = {},
): GraphErrorBody => ({
  error: { message, type: 'OAuthException', code, fbtrace_id: 'A1b2C3d4E5f6G7h8I9j0K1l', ...extra },
});

/** The answer to an accepted send. */
export const graphSendOk = (
  platform: MetaPlatform,
  input: { readonly id?: string; readonly to?: string } = {},
): Record<string, unknown> =>
  platform === 'whatsapp'
    ? {
        messaging_product: 'whatsapp',
        contacts: [{ input: input.to ?? META_FIXTURE.waId, wa_id: input.to ?? META_FIXTURE.waId }],
        messages: [{ id: input.id ?? fixtureWamid(500) }],
      }
    : {
        recipient_id: input.to ?? META_FIXTURE.psid,
        message_id: input.id ?? fixtureMid(500),
      };

/** The refusal of a send outside the reply window: `131047`, or `10` with sub-code `2018278`. */
export const graphWindowClosed = (platform: MetaPlatform): GraphErrorBody =>
  platform === 'whatsapp'
    ? graphError(131_047, 'Re-engagement message', {
        error_data: {
          messaging_product: 'whatsapp',
          details:
            'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
        },
      })
    : graphError(10, '(#10) This message is sent outside of allowed window.', {
        error_subcode: 2_018_278,
      });

/** The refusal of a second message to one WhatsApp user inside six seconds. */
export const graphPairRateLimited = (): GraphErrorBody =>
  graphError(131_056, '(#131056) (Business Account, Consumer Account) pair rate limit hit', {
    error_data: {
      messaging_product: 'whatsapp',
      details: 'Too many messages sent from this phone number to the same phone number.',
    },
  });

/** The refusal of an expired token. */
export const graphTokenExpired = (): GraphErrorBody =>
  graphError(
    190,
    'Error validating access token: Session has expired on Friday, 09-Oct-26 10:00:00 PDT.',
    {
      error_subcode: 463,
    },
  );

/** The refusal of a recipient who blocked the Page or cannot be reached. */
export const graphUserUnavailable = (): GraphErrorBody =>
  graphError(551, 'This person isn’t available right now.', { error_subcode: 1_545_041 });

/** `GET /{media-id}`: where the bytes are for the next five minutes. */
export const graphMediaMeta = (input: {
  readonly id: string;
  readonly url: string;
  readonly mimeType?: string;
  /** Hex, as this endpoint writes it. */
  readonly sha256: string;
  readonly fileSize: number;
}): Record<string, unknown> => ({
  messaging_product: 'whatsapp',
  url: input.url,
  mime_type: input.mimeType ?? 'image/jpeg',
  sha256: input.sha256,
  file_size: String(input.fileSize),
  id: input.id,
});

interface SubscribedAppInput {
  readonly appId?: string;
  readonly name?: string;
  readonly fields?: readonly string[];
}

/** One app in `GET /{id}/subscribed_apps`: WhatsApp wraps it, Messenger and Instagram list its fields. */
export const graphSubscribedApp = (
  platform: MetaPlatform,
  input: SubscribedAppInput = {},
): Record<string, unknown> => {
  const id = input.appId ?? META_FIXTURE.appId;
  const name = input.name ?? 'Helpdock';
  const link = `https://www.facebook.com/games/?app_id=${id}`;

  return platform === 'whatsapp'
    ? { whatsapp_business_api_data: { id, link, name } }
    : { id, name, link, subscribed_fields: input.fields ?? ['messages'] };
};

/** `GET /{id}/subscribed_apps`: who gets this account's webhooks. */
export const graphSubscribedApps = (
  platform: MetaPlatform,
  input: SubscribedAppInput = {},
): Record<string, unknown> => ({ data: [graphSubscribedApp(platform, input)] });

/** `GET /refresh_access_token`: a token good for another 60 days. */
export const graphRefreshToken = (input: {
  readonly accessToken: string;
  readonly expiresInSeconds?: number;
}): Record<string, unknown> => ({
  access_token: input.accessToken,
  token_type: 'bearer',
  expires_in: input.expiresInSeconds ?? 5_184_000,
});
