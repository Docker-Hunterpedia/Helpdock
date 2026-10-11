import { z } from 'zod';

/**
 * What Helpdock posts to `/{id}/messages` (M10-01), as Zod schemas: the
 * contract M10-06's `meta.send` builds against and the stand-in checks every
 * request with, so a body Graph would refuse fails a test before it fails a
 * customer. Strict, unlike the webhook schemas: this is Helpdock's own output,
 * and a field it did not mean to send is a bug.
 *
 * Templates are M10-09's and join the WhatsApp union then.
 */

// --------------------------------------------------------------------------
// WhatsApp
// --------------------------------------------------------------------------

/** What a WhatsApp media message names: an uploaded media id (preferred), or a link. */
const whatsappMediaSchema = z.union([
  z.strictObject({
    id: z.string().min(1),
    caption: z.string().max(1_024).optional(),
    filename: z.string().min(1).max(240).optional(),
  }),
  z.strictObject({
    link: z.url({ protocol: /^https$/ }),
    caption: z.string().max(1_024).optional(),
    filename: z.string().min(1).max(240).optional(),
  }),
]);

const whatsappBase = {
  messaging_product: z.literal('whatsapp'),
  recipient_type: z.literal('individual').optional(),
  /** The customer's number. From July 2026 `recipient` may carry the user id instead. */
  to: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  context: z.strictObject({ message_id: z.string().min(1) }).optional(),
};

const whatsappImagePayloadSchema = z.strictObject({
  ...whatsappBase,
  type: z.literal('image'),
  image: whatsappMediaSchema,
});
const whatsappAudioPayloadSchema = z.strictObject({
  ...whatsappBase,
  type: z.literal('audio'),
  audio: whatsappMediaSchema,
});
const whatsappVideoPayloadSchema = z.strictObject({
  ...whatsappBase,
  type: z.literal('video'),
  video: whatsappMediaSchema,
});
const whatsappDocumentPayloadSchema = z.strictObject({
  ...whatsappBase,
  type: z.literal('document'),
  document: whatsappMediaSchema,
});
const whatsappStickerPayloadSchema = z.strictObject({
  ...whatsappBase,
  type: z.literal('sticker'),
  sticker: whatsappMediaSchema,
});

export const whatsappTextPayloadSchema = z.strictObject({
  ...whatsappBase,
  type: z.literal('text'),
  text: z.strictObject({
    body: z.string().min(1),
    preview_url: z.boolean().optional(),
  }),
});

/** A message to a WhatsApp customer: text, or one file. */
export const whatsappSendPayloadSchema = z
  .discriminatedUnion('type', [
    whatsappTextPayloadSchema,
    whatsappImagePayloadSchema,
    whatsappAudioPayloadSchema,
    whatsappVideoPayloadSchema,
    whatsappDocumentPayloadSchema,
    whatsappStickerPayloadSchema,
  ])
  .refine((payload) => payload.to !== undefined || payload.recipient !== undefined, {
    message: 'a WhatsApp message names its recipient in to or recipient',
  });
export type WhatsAppSendPayload = z.infer<typeof whatsappSendPayloadSchema>;

// --------------------------------------------------------------------------
// Messenger and Instagram
// --------------------------------------------------------------------------

/** One attachment, by URL Meta fetches or by an id an upload returned. */
const messagingAttachmentSchema = z.strictObject({
  type: z.enum(['image', 'audio', 'video', 'file']),
  payload: z.union([
    z.strictObject({ url: z.url({ protocol: /^https?$/ }), is_reusable: z.boolean().optional() }),
    z.strictObject({ attachment_id: z.string().min(1) }),
  ]),
});

/**
 * A message to a Messenger or Instagram customer: text or one attachment, never
 * both (Graph takes one or the other), and `metadata` so the echo of Helpdock's
 * own send can be told from a message typed in the Page inbox.
 */
export const messagingSendPayloadSchema = z
  .strictObject({
    recipient: z.strictObject({ id: z.string().min(1) }),
    messaging_type: z.enum(['RESPONSE', 'UPDATE', 'MESSAGE_TAG']).optional(),
    /** `HUMAN_AGENT` is the one tag Helpdock sends (M10-09). */
    tag: z.literal('HUMAN_AGENT').optional(),
    message: z.strictObject({
      text: z.string().min(1).optional(),
      attachment: messagingAttachmentSchema.optional(),
      metadata: z.string().min(1).max(1_000).optional(),
    }),
  })
  .refine(
    (payload) =>
      (payload.message.text === undefined) !== (payload.message.attachment === undefined),
    {
      message: 'a message carries text or one attachment',
      path: ['message'],
    },
  )
  .refine((payload) => (payload.tag === undefined) === (payload.messaging_type !== 'MESSAGE_TAG'), {
    message: 'a tag goes with messaging_type MESSAGE_TAG and with nothing else',
    path: ['tag'],
  });
export type MessagingSendPayload = z.infer<typeof messagingSendPayloadSchema>;

/** The text of a send payload of either shape, or null for a file. */
export const sendPayloadText = (
  payload: WhatsAppSendPayload | MessagingSendPayload,
): string | null => {
  if ('message' in payload) {
    return payload.message.text ?? null;
  }
  return payload.type === 'text' ? payload.text.body : null;
};
