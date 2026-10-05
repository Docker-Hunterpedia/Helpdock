import { z } from 'zod';

/**
 * The part of a Bot API `Update` Helpdock reads (M6-01), validated at the
 * boundary like every other channel's inbound message. Objects are loose:
 * Telegram adds fields in every Bot API release, and a field nobody reads is no
 * reason to refuse an update.
 *
 * {@link classifyUpdate} turns one into the one thing Helpdock does with it.
 */

const userSchema = z.looseObject({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

const chatSchema = z.looseObject({
  id: z.number().int(),
  type: z.string(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const fileSchema = z.looseObject({
  file_id: z.string().min(1),
  file_size: z.number().int().nonnegative().optional(),
});

const locationSchema = z.looseObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const messageSchema = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(fileSchema.extend({ width: z.number(), height: z.number() })).optional(),
  document: fileSchema
    .extend({ file_name: z.string().optional(), mime_type: z.string().optional() })
    .optional(),
  voice: fileSchema.extend({ mime_type: z.string().optional() }).optional(),
  audio: fileSchema
    .extend({ file_name: z.string().optional(), mime_type: z.string().optional() })
    .optional(),
  video: fileSchema
    .extend({ file_name: z.string().optional(), mime_type: z.string().optional() })
    .optional(),
  location: locationSchema.optional(),
  venue: z
    .looseObject({ location: locationSchema, title: z.string(), address: z.string() })
    .optional(),
});

export const telegramUpdateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  callback_query: z
    .looseObject({
      id: z.string(),
      from: userSchema,
      message: z.looseObject({ chat: chatSchema }).optional(),
      data: z.string().optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

/** A file the message carries, to be fetched with `getFile`. */
export interface TelegramFileRef {
  readonly fileId: string;
  readonly filename: string;
  /** As Telegram declared it. The media pipeline sniffs the bytes and decides. */
  readonly contentType: string;
  /** When Telegram said; files over the Bot API's download limit are skipped. */
  readonly size: number | null;
}

export interface TelegramPoint {
  readonly latitude: number;
  readonly longitude: number;
  /** A venue's name and address, when the point is one. */
  readonly title: string | null;
  readonly address: string | null;
}

/** Who wrote, as Telegram describes them. */
export interface TelegramSender {
  readonly chatId: string;
  readonly name: string | null;
  /** `@username` without the `@`, when the customer has one. */
  readonly username: string | null;
  readonly languageCode: string | null;
}

export type TelegramEvent =
  | {
      readonly kind: 'message';
      readonly updateId: number;
      readonly messageId: number;
      readonly sender: TelegramSender;
      readonly text: string;
      readonly files: readonly TelegramFileRef[];
      readonly location: TelegramPoint | null;
      readonly sentAt: Date;
    }
  | { readonly kind: 'start'; readonly updateId: number; readonly sender: TelegramSender }
  | {
      readonly kind: 'language';
      readonly updateId: number;
      readonly sender: TelegramSender;
      readonly callbackQueryId: string;
      readonly locale: 'en' | 'ar';
    }
  | { readonly kind: 'ignored'; readonly updateId: number; readonly reason: IgnoredReason };

export type IgnoredReason =
  /** An edited message, a channel post, a poll: nothing a ticket is made of. */
  | 'unsupported-update'
  /** A group or channel. A bot answers one person per chat. */
  | 'not-private'
  /** Another bot. */
  | 'from-bot'
  /** A sticker, a contact card, a game: nothing to file. */
  | 'unsupported-content'
  /** A button press Helpdock did not draw. */
  | 'unknown-callback';

const nameOf = (person: {
  readonly first_name?: string | undefined;
  readonly last_name?: string | undefined;
  readonly username?: string | undefined;
}): string | null => {
  const full = [person.first_name, person.last_name]
    .filter((part) => part !== undefined)
    .join(' ')
    .trim();
  if (full !== '') {
    return full;
  }

  return person.username === undefined ? null : `@${person.username}`;
};

type TelegramMessage = z.infer<typeof messageSchema>;

const filesOf = (message: TelegramMessage): TelegramFileRef[] => {
  const files: TelegramFileRef[] = [];
  // Telegram sends a photo in several sizes, smallest first.
  const photo = message.photo?.at(-1);
  if (photo !== undefined) {
    files.push({
      fileId: photo.file_id,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      size: photo.file_size ?? null,
    });
  }
  if (message.document !== undefined) {
    files.push({
      fileId: message.document.file_id,
      filename: message.document.file_name ?? 'document',
      contentType: message.document.mime_type ?? 'application/octet-stream',
      size: message.document.file_size ?? null,
    });
  }
  if (message.voice !== undefined) {
    files.push({
      fileId: message.voice.file_id,
      filename: 'voice.ogg',
      contentType: message.voice.mime_type ?? 'audio/ogg',
      size: message.voice.file_size ?? null,
    });
  }
  if (message.audio !== undefined) {
    files.push({
      fileId: message.audio.file_id,
      filename: message.audio.file_name ?? 'audio',
      contentType: message.audio.mime_type ?? 'application/octet-stream',
      size: message.audio.file_size ?? null,
    });
  }
  if (message.video !== undefined) {
    files.push({
      fileId: message.video.file_id,
      filename: message.video.file_name ?? 'video.mp4',
      contentType: message.video.mime_type ?? 'video/mp4',
      size: message.video.file_size ?? null,
    });
  }

  return files;
};

const pointOf = (message: TelegramMessage): TelegramPoint | null => {
  if (message.venue !== undefined) {
    return {
      latitude: message.venue.location.latitude,
      longitude: message.venue.location.longitude,
      title: message.venue.title,
      address: message.venue.address,
    };
  }
  if (message.location !== undefined) {
    return {
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      title: null,
      address: null,
    };
  }

  return null;
};

/** `/start`, or `/start <payload>` from a deep link. */
const START = /^\/start(?:@\w+)?(?:\s|$)/;

/**
 * What to do with one update. Throws a `ZodError` when the body is not an
 * update at all, which the webhook answers 400.
 */
export const classifyUpdate = (raw: unknown): TelegramEvent => {
  const update = telegramUpdateSchema.parse(raw);
  const updateId = update.update_id;

  if (update.callback_query !== undefined) {
    const query = update.callback_query;
    const chat = query.message?.chat;
    if (chat === undefined || chat.type !== 'private') {
      return { kind: 'ignored', updateId, reason: 'not-private' };
    }
    const match = /^lang:(en|ar)$/.exec(query.data ?? '');
    if (match === null) {
      return { kind: 'ignored', updateId, reason: 'unknown-callback' };
    }

    return {
      kind: 'language',
      updateId,
      callbackQueryId: query.id,
      locale: match[1] === 'ar' ? 'ar' : 'en',
      sender: {
        chatId: String(chat.id),
        name: nameOf(query.from),
        username: query.from.username ?? null,
        languageCode: query.from.language_code ?? null,
      },
    };
  }

  const message = update.message;
  if (message === undefined) {
    return { kind: 'ignored', updateId, reason: 'unsupported-update' };
  }
  if (message.chat.type !== 'private') {
    return { kind: 'ignored', updateId, reason: 'not-private' };
  }
  if (message.from?.is_bot === true) {
    return { kind: 'ignored', updateId, reason: 'from-bot' };
  }

  const sender: TelegramSender = {
    chatId: String(message.chat.id),
    name: nameOf(message.from ?? message.chat),
    username: (message.from ?? message.chat).username ?? null,
    languageCode: message.from?.language_code ?? null,
  };
  const text = (message.text ?? message.caption ?? '').trim();
  if (message.text !== undefined && START.test(message.text)) {
    return { kind: 'start', updateId, sender };
  }

  const files = filesOf(message);
  const location = pointOf(message);
  if (text === '' && files.length === 0 && location === null) {
    return { kind: 'ignored', updateId, reason: 'unsupported-content' };
  }

  return {
    kind: 'message',
    updateId,
    messageId: message.message_id,
    sender,
    text,
    files,
    location,
    sentAt: new Date(message.date * 1_000),
  };
};
