import type { MetaFileRef, MetaPlatform } from '@helpdock/schemas';
import { z } from 'zod';
import { graphWebhookErrorSchema } from './errors.js';

/**
 * The webhook Meta posts (M10-01), validated at the boundary like every other
 * channel's inbound message. Objects are loose: Meta adds fields in every Graph
 * version, and a field nobody reads is no reason to refuse a delivery.
 *
 * One `POST` is an **envelope**: `{ object, entry[] }`. {@link metaEnvelopeSchema}
 * checks that much and no more, because the events inside it are Meta's and
 * one malformed event must not cost the batch. {@link routeEnvelope} then cuts
 * the envelope into what belongs to one account each and turns every event
 * into the one thing Helpdock does with it ({@link MetaEvent}); an event it
 * cannot read becomes an `ignored` one, never an exception.
 */

export type { MetaFileRef } from '@helpdock/schemas';

// --------------------------------------------------------------------------
// The envelope
// --------------------------------------------------------------------------

/** Ids are strings on the wire, but some arrive as numbers (`app_id`, an entry's `id` in older tests). */
const idSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

const whatsappEntrySchema = z.looseObject({
  id: idSchema,
  time: z.number().optional(),
  changes: z.array(z.looseObject({ field: z.string(), value: z.looseObject({}) })).default([]),
});

const messagingEntrySchema = z.looseObject({
  id: idSchema,
  time: z.number().optional(),
  // Parsed one at a time by `classifyMessagingEvent`, so one bad event is one
  // ignored event and not a refused batch.
  messaging: z.array(z.unknown()).default([]),
  standby: z.array(z.unknown()).default([]),
  changes: z.array(z.unknown()).default([]),
});

export const whatsappEnvelopeSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(whatsappEntrySchema),
});

export const pageEnvelopeSchema = z.looseObject({
  object: z.literal('page'),
  entry: z.array(messagingEntrySchema),
});

export const instagramEnvelopeSchema = z.looseObject({
  object: z.literal('instagram'),
  entry: z.array(messagingEntrySchema),
});

/** A webhook body, by the `object` Meta names. A ZodError from it is the route's 400. */
export const metaEnvelopeSchema = z.discriminatedUnion('object', [
  whatsappEnvelopeSchema,
  pageEnvelopeSchema,
  instagramEnvelopeSchema,
]);
export type MetaEnvelope = z.infer<typeof metaEnvelopeSchema>;

/** The platform an envelope's `object` belongs to. */
export const platformOfObject = (object: MetaEnvelope['object']): MetaPlatform => {
  switch (object) {
    case 'whatsapp_business_account':
      return 'whatsapp';
    case 'page':
      return 'messenger';
    case 'instagram':
      return 'instagram';
  }
};

// --------------------------------------------------------------------------
// What an event is
// --------------------------------------------------------------------------

/** A WhatsApp location message, as the thread files it: a line with a map link. */
export interface MetaPoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string | null;
  readonly address: string | null;
  readonly url: string | null;
}

/** One contact a WhatsApp customer shared. */
export interface MetaSharedContact {
  readonly name: string;
  readonly org: string | null;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
}

/** An Instagram story the customer replied to or mentioned the account in. */
export interface MetaStory {
  readonly kind: 'reply' | 'mention';
  readonly id: string | null;
  readonly url: string | null;
}

/** A shared post, reel or link the thread files as a line with its URL. */
export interface MetaLink {
  readonly type: string;
  readonly url: string;
  readonly title: string | null;
}

/** An `errors[]` entry of a webhook: media Meta could not serve, a failed send. */
export interface MetaEventError {
  readonly code: number | null;
  readonly title: string | null;
  readonly message: string | null;
}

export type MetaIgnoredReason =
  /** A WhatsApp field other than `messages`, or an Instagram `changes` field. */
  | 'field'
  /** An event on the `standby` channel: another app holds the thread. */
  | 'standby'
  /** An event whose shape is not one Helpdock reads. */
  | 'malformed'
  /** A kind of event Helpdock has no use for (`optin`, `account_linking`, …). */
  | 'unknown-event'
  /** A WhatsApp message that names no customer. */
  | 'no-customer'
  /** A WhatsApp status other than the four Helpdock follows. */
  | 'status'
  /** A WhatsApp system message other than a change of number. */
  | 'system'
  /** A message with nothing in it to file. */
  | 'empty';

interface EventBase {
  readonly platform: MetaPlatform;
  /** When Meta says it happened, or null when it says nothing. */
  readonly timestamp: Date | null;
}

/**
 * What one webhook event is. `customerId` is the platform's own id for the
 * customer, as Meta sends it: the WhatsApp business-scoped user id (the phone
 * number only when Meta sent no user id), the Messenger page-scoped id, the
 * Instagram-scoped id. The account's id is not part of it; the identity
 * Helpdock stores adds that (`metaIdentityValue`).
 */
export type MetaEvent =
  | (EventBase & {
      readonly kind: 'message';
      readonly customerId: string;
      /** WhatsApp: the customer's number in digits, when Meta sent it. */
      readonly waId: string | null;
      readonly profileName: string | null;
      /** WhatsApp username or Instagram `@handle`, without the `@`, when Meta sent one. */
      readonly username: string | null;
      /** `wamid.…` or `mid`: the dedupe key. */
      readonly messageId: string;
      readonly text: string;
      /** The message this one answers (`context.id`, `reply_to.mid`). */
      readonly quotedId: string | null;
      readonly forwarded: boolean;
      readonly files: readonly MetaFileRef[];
      readonly location: MetaPoint | null;
      readonly contacts: readonly MetaSharedContact[];
      readonly story: MetaStory | null;
      readonly links: readonly MetaLink[];
      /** Attachment types the message carried that have nothing to fetch or show. */
      readonly unsupportedAttachments: readonly string[];
      /** Errors Meta attached to the message, such as a media file it could not serve. */
      readonly errors: readonly MetaEventError[];
    })
  | (EventBase & {
      /** A message the business sent, as Meta echoes it back. */
      readonly kind: 'echo';
      readonly customerId: string;
      readonly messageId: string;
      readonly appId: string | null;
      /** The string Helpdock set on the send (a delivery id), when this is one of its own. */
      readonly metadata: string | null;
      readonly text: string;
    })
  | (EventBase & {
      /** WhatsApp: a reply's progress, per message. */
      readonly kind: 'status';
      readonly messageId: string;
      readonly customerId: string | null;
      readonly status: 'sent' | 'delivered' | 'read' | 'failed';
      readonly pricingCategory: string | null;
      readonly errors: readonly MetaEventError[];
    })
  | (EventBase & {
      /** Messenger: every message to this customer before the watermark has arrived. */
      readonly kind: 'delivery';
      readonly customerId: string;
      readonly watermark: Date | null;
      readonly mids: readonly string[];
    })
  | (EventBase & {
      /** Messenger: every message to this customer before the watermark has been read. */
      readonly kind: 'read';
      readonly customerId: string;
      readonly watermark: Date | null;
    })
  | (EventBase & {
      /** Instagram: one message has been seen. */
      readonly kind: 'seen';
      readonly customerId: string;
      readonly messageId: string;
    })
  | (EventBase & {
      readonly kind: 'reaction';
      readonly customerId: string;
      /** The message reacted to. */
      readonly messageId: string;
      readonly action: 'react' | 'unreact';
      readonly emoji: string | null;
    })
  | (EventBase & {
      readonly kind: 'edit';
      readonly customerId: string;
      readonly messageId: string;
      readonly text: string;
      readonly editNumber: number | null;
    })
  | (EventBase & {
      /** Instagram: the customer unsent a message. */
      readonly kind: 'deleted';
      readonly customerId: string;
      readonly messageId: string;
    })
  | (EventBase & {
      readonly kind: 'postback';
      readonly customerId: string;
      readonly messageId: string | null;
      readonly title: string | null;
      readonly payload: string | null;
    })
  | (EventBase & {
      readonly kind: 'referral';
      readonly customerId: string;
      readonly source: string | null;
    })
  | (EventBase & {
      /** Something Meta says it sent that Helpdock cannot show. */
      readonly kind: 'unsupported';
      readonly customerId: string | null;
      readonly messageId: string | null;
      readonly detail: string | null;
      readonly errors: readonly MetaEventError[];
    })
  | (EventBase & {
      /** WhatsApp: the customer's number changed. */
      readonly kind: 'user_changed_number';
      readonly customerId: string | null;
      readonly oldWaId: string | null;
      readonly newWaId: string | null;
    })
  | (EventBase & {
      /** Messenger: Meta blocked, warned or unblocked the Page. */
      readonly kind: 'policy_enforcement';
      readonly action: string | null;
      readonly reason: string | null;
    })
  | (EventBase & {
      /** WhatsApp: an error about the account itself, not a message. */
      readonly kind: 'error';
      readonly errors: readonly MetaEventError[];
    })
  | (EventBase & {
      readonly kind: 'ignored';
      readonly reason: MetaIgnoredReason;
      readonly detail: string | null;
    });

export type MetaEventKind = MetaEvent['kind'];

/** One `message` event, as the three adapters take it. */
export type MetaMessageEvent = Extract<MetaEvent, { kind: 'message' }>;

const ignored = (
  platform: MetaPlatform,
  reason: MetaIgnoredReason,
  detail: string | null = null,
  timestamp: Date | null = null,
): MetaEvent => ({ kind: 'ignored', platform, reason, detail, timestamp });

const errorsOf = (
  list: readonly z.infer<typeof graphWebhookErrorSchema>[] | undefined,
): MetaEventError[] =>
  (list ?? []).map((error) => ({
    code: error.code ?? null,
    title: error.title ?? null,
    message: error.error_data?.details ?? error.message ?? null,
  }));

const secondsToDate = (value: string | number | undefined): Date | null => {
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000) : null;
};

const millisToDate = (value: number | undefined): Date | null =>
  value === undefined || !Number.isFinite(value) || value <= 0 ? null : new Date(value);

// --------------------------------------------------------------------------
// WhatsApp
// --------------------------------------------------------------------------

const mediaSchema = z.looseObject({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});

const whatsappContactSchema = z.looseObject({
  wa_id: z.string().optional(),
  user_id: z.string().optional(),
  username: z.string().optional(),
  profile: z
    .looseObject({ name: z.string().optional(), username: z.string().optional() })
    .optional(),
});

const sharedContactSchema = z.looseObject({
  name: z
    .looseObject({
      formatted_name: z.string().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    })
    .optional(),
  org: z.looseObject({ company: z.string().optional() }).optional(),
  phones: z.array(z.looseObject({ phone: z.string().optional() })).optional(),
  emails: z.array(z.looseObject({ email: z.string().optional() })).optional(),
});

const whatsappMessageSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().optional(),
  from_user_id: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  location: z
    .looseObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: z.string().optional(),
      address: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  contacts: z.array(sharedContactSchema).optional(),
  reaction: z.looseObject({ message_id: z.string(), emoji: z.string().optional() }).optional(),
  button: z.looseObject({ text: z.string().optional(), payload: z.string().optional() }).optional(),
  interactive: z
    .looseObject({
      type: z.string().optional(),
      button_reply: z.looseObject({ title: z.string().optional() }).optional(),
      list_reply: z.looseObject({ title: z.string().optional() }).optional(),
    })
    .optional(),
  system: z
    .looseObject({
      type: z.string().optional(),
      wa_id: z.string().optional(),
      new_wa_id: z.string().optional(),
      customer: z.string().optional(),
      user_id: z.string().optional(),
    })
    .optional(),
  context: z
    .looseObject({
      id: z.string().optional(),
      forwarded: z.boolean().optional(),
      frequently_forwarded: z.boolean().optional(),
    })
    .optional(),
  errors: z.array(graphWebhookErrorSchema).optional(),
});
type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>;

const whatsappStatusSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  recipient_id: z.string().optional(),
  recipient_user_id: z.string().optional(),
  pricing: z.looseObject({ category: z.string().optional() }).optional(),
  errors: z.array(graphWebhookErrorSchema).optional(),
});

/** The `value` of a `messages` change: the number it is for and what happened on it. */
const whatsappValueSchema = z.looseObject({
  metadata: z.looseObject({
    phone_number_id: idSchema,
    display_phone_number: z.string().optional(),
  }),
  contacts: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
  errors: z.array(graphWebhookErrorSchema).optional(),
});

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;

const digitsOnly = (value: string | undefined): string | null => {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits === '' ? null : digits;
};

type WhatsAppContact = z.infer<typeof whatsappContactSchema>;

/**
 * Which of a value's `contacts` a message is from. A message names its sender by
 * number (`from`) or, for a customer who has adopted a username, by user id
 * (`from_user_id`) or by nothing but the position it shares with the one
 * contact beside it.
 */
const contactFor = (
  message: WhatsAppMessage,
  contacts: readonly WhatsAppContact[],
): WhatsAppContact | undefined =>
  contacts.find(
    (contact) =>
      (message.from_user_id !== undefined && contact.user_id === message.from_user_id) ||
      (message.from !== undefined && message.from !== '' && contact.wa_id === message.from),
  ) ?? (contacts.length === 1 ? contacts[0] : undefined);

const mediaRef = (message: WhatsAppMessage): MetaFileRef[] =>
  MEDIA_TYPES.flatMap((type): MetaFileRef[] => {
    const media = message[type];
    if (media === undefined) {
      return [];
    }

    return [
      {
        kind: 'whatsapp_media',
        type,
        mediaId: media.id,
        mimeType: media.mime_type ?? 'application/octet-stream',
        sha256: media.sha256 ?? null,
        ...(media.filename === undefined ? {} : { filename: media.filename }),
        ...(media.voice === undefined ? {} : { voice: media.voice }),
      },
    ];
  });

const captionOf = (message: WhatsAppMessage): string =>
  message.text?.body ??
  message.image?.caption ??
  message.video?.caption ??
  message.document?.caption ??
  message.button?.text ??
  message.interactive?.button_reply?.title ??
  message.interactive?.list_reply?.title ??
  '';

const sharedContactsOf = (message: WhatsAppMessage): MetaSharedContact[] =>
  (message.contacts ?? []).map((contact) => {
    const phones = (contact.phones ?? []).flatMap((entry) =>
      entry.phone === undefined || entry.phone === '' ? [] : [entry.phone],
    );
    const emails = (contact.emails ?? []).flatMap((entry) =>
      entry.email === undefined || entry.email === '' ? [] : [entry.email],
    );
    const name =
      contact.name?.formatted_name ??
      [contact.name?.first_name, contact.name?.last_name]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' ');

    return { name, org: contact.org?.company ?? null, phones, emails };
  });

/** One WhatsApp message as an event. Everything Helpdock does not file is `unsupported` or `ignored`. */
const classifyWhatsAppMessage = (
  message: WhatsAppMessage,
  contacts: readonly WhatsAppContact[],
): MetaEvent => {
  const platform = 'whatsapp';
  const timestamp = secondsToDate(message.timestamp);
  const contact = contactFor(message, contacts);
  const waId = digitsOnly(contact?.wa_id ?? message.from);
  const customerId = contact?.user_id ?? message.from_user_id ?? waId;
  const errors = errorsOf(message.errors);

  if (message.type === 'system') {
    const system = message.system;
    if (system?.type === 'user_changed_number' || system?.type === 'customer_changed_number') {
      return {
        kind: 'user_changed_number',
        platform,
        timestamp,
        customerId: customerId ?? null,
        oldWaId: digitsOnly(system.customer),
        newWaId: digitsOnly(system.wa_id ?? system.new_wa_id),
      };
    }
    return ignored(platform, 'system', system?.type ?? null, timestamp);
  }

  if (message.type === 'unsupported') {
    return {
      kind: 'unsupported',
      platform,
      timestamp,
      customerId: customerId ?? null,
      messageId: message.id,
      detail: errors[0]?.title ?? null,
      errors,
    };
  }

  if (customerId === undefined || customerId === null) {
    return ignored(platform, 'no-customer', message.type, timestamp);
  }

  if (message.type === 'reaction') {
    const emoji = message.reaction?.emoji ?? '';
    return message.reaction === undefined
      ? ignored(platform, 'malformed', 'reaction', timestamp)
      : {
          kind: 'reaction',
          platform,
          timestamp,
          customerId,
          messageId: message.reaction.message_id,
          action: emoji === '' ? 'unreact' : 'react',
          emoji: emoji === '' ? null : emoji,
        };
  }

  const files = mediaRef(message);
  const text = captionOf(message);
  const location =
    message.location === undefined
      ? null
      : {
          latitude: message.location.latitude,
          longitude: message.location.longitude,
          name: message.location.name ?? null,
          address: message.location.address ?? null,
          url: message.location.url ?? null,
        };
  const shared = sharedContactsOf(message);
  if (text === '' && files.length === 0 && location === null && shared.length === 0) {
    // An empty text is nothing to file. Anything else with no content Helpdock
    // can read — `order`, `request_welcome`, an interactive reply without a
    // title — is something Meta sent that the thread says it cannot show.
    return message.type === 'text'
      ? ignored(platform, 'empty', null, timestamp)
      : {
          kind: 'unsupported',
          platform,
          timestamp,
          customerId,
          messageId: message.id,
          detail: message.type,
          errors,
        };
  }

  return {
    kind: 'message',
    platform,
    timestamp,
    customerId,
    waId,
    profileName: contact?.profile?.name ?? null,
    username: contact?.username ?? contact?.profile?.username ?? null,
    messageId: message.id,
    text,
    quotedId: message.context?.id ?? null,
    forwarded:
      message.context?.forwarded === true || message.context?.frequently_forwarded === true,
    files,
    location,
    contacts: shared,
    story: null,
    links: [],
    unsupportedAttachments: [],
    errors,
  };
};

const WHATSAPP_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;

const classifyWhatsAppStatus = (status: z.infer<typeof whatsappStatusSchema>): MetaEvent => {
  const timestamp = secondsToDate(status.timestamp);
  const followed = WHATSAPP_STATUSES.find((candidate) => candidate === status.status);
  if (followed === undefined) {
    return ignored('whatsapp', 'status', status.status, timestamp);
  }

  return {
    kind: 'status',
    platform: 'whatsapp',
    timestamp,
    messageId: status.id,
    customerId: status.recipient_user_id ?? digitsOnly(status.recipient_id),
    status: followed,
    pricingCategory: status.pricing?.category ?? null,
    errors: errorsOf(status.errors),
  };
};

/**
 * Everything one `messages` change of a WhatsApp webhook says: its messages, its
 * statuses and its errors, in that order. The change's `value` is the unit
 * Meta groups by number, so it is also the unit {@link routeEnvelope} routes.
 * A malformed message or status is one `ignored` event and costs no other.
 */
export const classifyWhatsAppValue = (value: unknown): MetaEvent[] => {
  const parsed = whatsappValueSchema.safeParse(value);
  if (!parsed.success) {
    return [ignored('whatsapp', 'malformed', 'value')];
  }
  const { data } = parsed;

  const contacts = (data.contacts ?? []).flatMap((entry) => {
    const contact = whatsappContactSchema.safeParse(entry);
    return contact.success ? [contact.data] : [];
  });
  const events: MetaEvent[] = [];

  for (const entry of data.messages ?? []) {
    const message = whatsappMessageSchema.safeParse(entry);
    events.push(
      message.success
        ? classifyWhatsAppMessage(message.data, contacts)
        : ignored('whatsapp', 'malformed', 'message'),
    );
  }
  for (const entry of data.statuses ?? []) {
    const status = whatsappStatusSchema.safeParse(entry);
    events.push(
      status.success
        ? classifyWhatsAppStatus(status.data)
        : ignored('whatsapp', 'malformed', 'status'),
    );
  }
  if (data.errors !== undefined && data.errors.length > 0) {
    events.push({
      kind: 'error',
      platform: 'whatsapp',
      timestamp: null,
      errors: errorsOf(data.errors),
    });
  }

  return events;
};

// --------------------------------------------------------------------------
// Messenger and Instagram
// --------------------------------------------------------------------------

const attachmentSchema = z.looseObject({
  type: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  payload: z
    .looseObject({
      url: z.string().optional(),
      coordinates: z.looseObject({ lat: z.number(), long: z.number() }).optional(),
    })
    .nullable()
    .optional(),
});

const messagingMessageSchema = z.looseObject({
  mid: z.string().min(1).optional(),
  text: z.string().optional(),
  is_echo: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  is_unsupported: z.boolean().optional(),
  app_id: idSchema.optional(),
  metadata: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  reply_to: z
    .looseObject({
      mid: z.string().optional(),
      story: z.looseObject({ id: idSchema.optional(), url: z.string().optional() }).optional(),
    })
    .optional(),
});

const messagingEventSchema = z.looseObject({
  sender: z.looseObject({ id: idSchema }).optional(),
  recipient: z.looseObject({ id: idSchema }).optional(),
  timestamp: z.number().optional(),
  message: messagingMessageSchema.optional(),
  delivery: z
    .looseObject({ mids: z.array(z.string()).optional(), watermark: z.number().optional() })
    .optional(),
  read: z.looseObject({ watermark: z.number().optional(), mid: z.string().optional() }).optional(),
  reaction: z
    .looseObject({
      mid: z.string(),
      action: z.string().optional(),
      emoji: z.string().optional(),
    })
    .optional(),
  message_edit: z
    .looseObject({ mid: z.string(), text: z.string().optional(), num_edit: z.number().optional() })
    .optional(),
  postback: z
    .looseObject({
      mid: z.string().optional(),
      title: z.string().optional(),
      payload: z.string().optional(),
    })
    .optional(),
  referral: z.looseObject({ ref: z.string().optional(), source: z.string().optional() }).optional(),
  // Meta's own spelling, hyphen and all.
  'policy-enforcement': z
    .looseObject({ action: z.string().optional(), reason: z.string().optional() })
    .optional(),
});

/** Attachment types that are a file to fetch. */
const FILE_ATTACHMENTS = new Set(['image', 'video', 'audio', 'file', 'sticker']);
/** Attachment types that are a link to a post, a reel or a page. */
const LINK_ATTACHMENTS = new Set(['share', 'post', 'ig_post', 'reel', 'ig_reel', 'fallback']);

type MessagingMessage = z.infer<typeof messagingMessageSchema>;

interface AttachmentFacts {
  readonly files: readonly MetaFileRef[];
  readonly links: readonly MetaLink[];
  readonly location: MetaPoint | null;
  readonly story: MetaStory | null;
  readonly unsupported: readonly string[];
}

const attachmentsOf = (message: MessagingMessage): AttachmentFacts => {
  const files: MetaFileRef[] = [];
  const links: MetaLink[] = [];
  const unsupported: string[] = [];
  let location: MetaPoint | null = null;
  let story: MetaStory | null = null;

  const replyStory = message.reply_to?.story;
  if (replyStory !== undefined) {
    story = { kind: 'reply', id: replyStory.id ?? null, url: replyStory.url ?? null };
    if (replyStory.url !== undefined) {
      files.push({ kind: 'cdn_url', url: replyStory.url, type: 'story' });
    }
  }

  for (const attachment of message.attachments ?? []) {
    const type = attachment.type ?? '';
    const url = attachment.payload?.url ?? attachment.url;
    const coordinates = attachment.payload?.coordinates;

    if (type === 'location' && coordinates !== undefined) {
      location = {
        latitude: coordinates.lat,
        longitude: coordinates.long,
        name: attachment.title ?? null,
        address: null,
        url: attachment.url ?? null,
      };
    } else if (url === undefined || url === '') {
      unsupported.push(type === '' ? 'unknown' : type);
    } else if (type === 'story_mention') {
      files.push({ kind: 'cdn_url', url, type });
      story = { kind: 'mention', id: null, url };
    } else if (FILE_ATTACHMENTS.has(type)) {
      files.push({ kind: 'cdn_url', url, type });
    } else if (LINK_ATTACHMENTS.has(type)) {
      links.push({ type, url, title: attachment.title ?? null });
    } else {
      unsupported.push(type === '' ? 'unknown' : type);
    }
  }

  return { files, links, location, story, unsupported };
};

const classifyMessagingMessage = (
  event: z.infer<typeof messagingEventSchema>,
  message: MessagingMessage,
  platform: MetaPlatform,
  timestamp: Date | null,
): MetaEvent => {
  const sender = event.sender?.id;
  const recipient = event.recipient?.id;
  const mid = message.mid;

  if (message.is_echo === true) {
    return recipient === undefined || mid === undefined
      ? ignored(platform, 'malformed', 'echo', timestamp)
      : {
          kind: 'echo',
          platform,
          timestamp,
          customerId: recipient,
          messageId: mid,
          appId: message.app_id ?? null,
          metadata: message.metadata ?? null,
          text: message.text ?? '',
        };
  }
  if (sender === undefined || mid === undefined) {
    return ignored(platform, 'malformed', 'message', timestamp);
  }
  if (message.is_deleted === true) {
    return { kind: 'deleted', platform, timestamp, customerId: sender, messageId: mid };
  }

  const attachments = attachmentsOf(message);
  const text = message.text ?? '';
  const hasContent =
    text !== '' ||
    attachments.files.length > 0 ||
    attachments.links.length > 0 ||
    attachments.location !== null;
  if (message.is_unsupported === true || !hasContent) {
    return {
      kind: 'unsupported',
      platform,
      timestamp,
      customerId: sender,
      messageId: mid,
      detail: attachments.unsupported[0] ?? null,
      errors: [],
    };
  }

  return {
    kind: 'message',
    platform,
    timestamp,
    customerId: sender,
    waId: null,
    profileName: null,
    username: null,
    messageId: mid,
    text,
    quotedId: message.reply_to?.mid ?? null,
    forwarded: false,
    files: attachments.files,
    location: attachments.location,
    contacts: [],
    story: attachments.story,
    links: attachments.links,
    unsupportedAttachments: attachments.unsupported,
    errors: [],
  };
};

/**
 * One entry of `messaging[]` on a Page or Instagram webhook as an event. The
 * shapes of the two platforms are the same but for three things this reads
 * from the event itself: Instagram's `read` carries a `mid` (a message seen)
 * where Messenger's carries a `watermark`, its echoes arrive inside `messages`,
 * and it flags an unsent message with `is_deleted`.
 */
export const classifyMessagingEvent = (event: unknown, platform: MetaPlatform): MetaEvent => {
  const parsed = messagingEventSchema.safeParse(event);
  if (!parsed.success) {
    return ignored(platform, 'malformed', 'event');
  }
  const data = parsed.data;
  const timestamp = millisToDate(data.timestamp);
  const sender = data.sender?.id;

  if (data.message !== undefined) {
    return classifyMessagingMessage(data, data.message, platform, timestamp);
  }
  if (data['policy-enforcement'] !== undefined) {
    return {
      kind: 'policy_enforcement',
      platform,
      timestamp,
      action: data['policy-enforcement'].action ?? null,
      reason: data['policy-enforcement'].reason ?? null,
    };
  }
  if (sender === undefined) {
    return ignored(platform, 'malformed', 'sender', timestamp);
  }

  if (data.delivery !== undefined) {
    return {
      kind: 'delivery',
      platform,
      timestamp,
      customerId: sender,
      watermark: millisToDate(data.delivery.watermark),
      mids: data.delivery.mids ?? [],
    };
  }
  if (data.read !== undefined) {
    return data.read.mid === undefined
      ? {
          kind: 'read',
          platform,
          timestamp,
          customerId: sender,
          watermark: millisToDate(data.read.watermark),
        }
      : { kind: 'seen', platform, timestamp, customerId: sender, messageId: data.read.mid };
  }
  if (data.reaction !== undefined) {
    return {
      kind: 'reaction',
      platform,
      timestamp,
      customerId: sender,
      messageId: data.reaction.mid,
      action: data.reaction.action === 'unreact' ? 'unreact' : 'react',
      emoji: data.reaction.emoji ?? null,
    };
  }
  if (data.message_edit !== undefined) {
    return {
      kind: 'edit',
      platform,
      timestamp,
      customerId: sender,
      messageId: data.message_edit.mid,
      text: data.message_edit.text ?? '',
      editNumber: data.message_edit.num_edit ?? null,
    };
  }
  if (data.postback !== undefined) {
    return {
      kind: 'postback',
      platform,
      timestamp,
      customerId: sender,
      messageId: data.postback.mid ?? null,
      title: data.postback.title ?? null,
      payload: data.postback.payload ?? null,
    };
  }
  if (data.referral !== undefined) {
    return {
      kind: 'referral',
      platform,
      timestamp,
      customerId: sender,
      source: data.referral.source ?? data.referral.ref ?? null,
    };
  }

  return ignored(platform, 'unknown-event', null, timestamp);
};

// --------------------------------------------------------------------------
// Routing
// --------------------------------------------------------------------------

/**
 * The events of one connected account in one envelope. `externalId` is what
 * `meta_accounts.external_id` holds: the WhatsApp phone number id, the Page id
 * or the Instagram account id.
 */
export interface MetaRoute {
  readonly platform: MetaPlatform;
  readonly externalId: string;
  /** WhatsApp: the business account id of the entry, which names no number. */
  readonly wabaId: string | null;
  readonly events: readonly MetaEvent[];
}

/** Something in an envelope that names no account: counted by the route, filed by nobody. */
export interface MetaUnrouted {
  readonly platform: MetaPlatform;
  readonly field: string;
  readonly reason: 'field' | 'malformed';
}

export interface MetaRouting {
  readonly routes: readonly MetaRoute[];
  readonly unrouted: readonly MetaUnrouted[];
}

/**
 * Cuts an envelope into what belongs to one account each. WhatsApp routes by
 * the number a change is about (`value.metadata.phone_number_id`), not by the
 * entry, because one business account can hold several numbers and Helpdock may
 * have connected them to different brands; Messenger and Instagram route by the
 * entry's id. Events of one account stay in the order Meta sent them.
 */
export const routeEnvelope = (envelope: MetaEnvelope): MetaRouting => {
  const grouped = new Map<
    string,
    { platform: MetaPlatform; externalId: string; wabaId: string | null; events: MetaEvent[] }
  >();
  const unrouted: MetaUnrouted[] = [];

  const add = (
    platform: MetaPlatform,
    externalId: string,
    wabaId: string | null,
    events: readonly MetaEvent[],
  ): void => {
    const key = `${platform}:${externalId}`;
    const route = grouped.get(key) ?? { platform, externalId, wabaId, events: [] };
    route.events.push(...events);
    grouped.set(key, route);
  };

  if (envelope.object === 'whatsapp_business_account') {
    for (const entry of envelope.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') {
          unrouted.push({ platform: 'whatsapp', field: change.field, reason: 'field' });
          continue;
        }
        const value = whatsappValueSchema.safeParse(change.value);
        if (!value.success) {
          unrouted.push({ platform: 'whatsapp', field: 'messages', reason: 'malformed' });
          continue;
        }
        add(
          'whatsapp',
          value.data.metadata.phone_number_id,
          entry.id,
          classifyWhatsAppValue(change.value),
        );
      }
    }
  } else {
    const platform = platformOfObject(envelope.object);
    for (const entry of envelope.entry) {
      add(platform, entry.id, null, [
        ...entry.messaging.map((event) => classifyMessagingEvent(event, platform)),
        ...entry.standby.map(() => ignored(platform, 'standby')),
        ...entry.changes.map(() => ignored(platform, 'field')),
      ]);
    }
  }

  return { routes: [...grouped.values()], unrouted };
};

// --------------------------------------------------------------------------
// Identity and the dedupe key
// --------------------------------------------------------------------------

/**
 * The dedupe key of DOMAIN-RULES §6 for one message: the id Meta gave it,
 * unchanged. `wamid.…` and `mid` are unique across Meta, so no account or
 * conversation needs to be prefixed; the function exists so the three
 * inbound services cannot come to spell the key three ways.
 */
export const metaExternalId = (_platform: MetaPlatform, messageId: string): string => messageId;

/**
 * The value stored in `contact_identities` for a customer (DOMAIN-RULES §4.7):
 * the WhatsApp user id as it is, and for Messenger and Instagram
 * `<account id>:<customer id>`, because both are scoped to the Page or account
 * and the same number can recur under two of them.
 */
export const metaIdentityValue = (
  platform: MetaPlatform,
  accountExternalId: string,
  customerId: string,
): string => (platform === 'whatsapp' ? customerId : `${accountExternalId}:${customerId}`);
