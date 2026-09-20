import { z } from 'zod';

/**
 * The wire contract for attachments and the per-brand content policy (M1-10),
 * shared by the api, the admin app and — from M4 — the widget, so that the rule
 * an upload is refused by is the same rule the composer greys a button out
 * with.
 *
 * Two specifications meet here. [REQUIREMENTS
 * §4.6](../../../docs/planning/REQUIREMENTS.md#46-live-chat-widget) names the
 * policy a Team Leader controls — "text · emoji · images · video · voice
 * messages · files — each on/off, max size, allowed MIME types, max attachments
 * per message" — and [ARCHITECTURE
 * §9](../../../docs/planning/ARCHITECTURE.md#9-media-pipeline) names the
 * pipeline that enforces it: presign, upload, confirm, process, serve.
 */

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------

/**
 * What an attachment is, which decides what the worker does to it: an image is
 * re-encoded, a voice note is normalised to Opus, a video keeps its bytes and
 * gains a poster, and everything else is a file that is scanned and served as a
 * download.
 */
export const attachmentKindSchema = z.enum(['image', 'video', 'audio', 'file']);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * Where an attachment is in the pipeline.
 *
 * `pending` is a row with a presigned URL and, quite possibly, no object behind
 * it — a composer that was abandoned leaves one. `ready` is the only state a
 * download is issued for, because it is the only one whose bytes have been
 * sniffed, re-encoded and scanned.
 */
export const attachmentStatusSchema = z.enum([
  'pending',
  'processing',
  'ready',
  'rejected',
  'infected',
]);
export type AttachmentStatus = z.infer<typeof attachmentStatusSchema>;

/** The outcome of the optional ClamAV pass (ARCHITECTURE §9, §17). */
export const attachmentScanStatusSchema = z.enum(['skipped', 'clean', 'infected', 'error']);
export type AttachmentScanStatus = z.infer<typeof attachmentScanStatusSchema>;

/**
 * Who uploaded it. Narrower than `message_author_type`: an AI never uploads
 * anything in v1 (AGENTS.md, "the model reads knowledge and writes text").
 */
export const attachmentUploaderTypeSchema = z.enum(['staff', 'contact', 'system']);
export type AttachmentUploaderType = z.infer<typeof attachmentUploaderTypeSchema>;

/**
 * Why an attachment was refused, as a key rather than a sentence.
 *
 * It is stored on the row and returned to the client, so it must never carry a
 * path, a command line or a tool's stderr: those name the worker's filesystem
 * and the binaries on it. The admin renders a translated string from the key,
 * which is the rule every other refusal in the api already follows.
 */
export const attachmentRejectReasonSchema = z.enum([
  /** The magic bytes disagree with the MIME the client declared. */
  'mime_mismatch',
  /** The declared MIME is not on the brand's allow-list for that kind. */
  'mime_not_allowed',
  /** The brand has that kind switched off. */
  'kind_disabled',
  /** Bigger than the brand's cap for that kind, at presign or at confirm. */
  'too_large',
  /** Confirm found no object, or the worker could not download one. */
  'object_missing',
  /** The bytes are of the right family but could not be decoded. */
  'unreadable',
  /** A conversion ran past its budget and was killed. */
  'timeout',
  /** The scanner was configured but could not be reached or did not answer. */
  'scan_error',
  /** The scanner found something. The object is deleted; the row is kept. */
  'infected',
  /** Anything else the worker could not finish. */
  'processing_failed',
]);
export type AttachmentRejectReason = z.infer<typeof attachmentRejectReasonSchema>;

// --------------------------------------------------------------------------
// The content policy
// --------------------------------------------------------------------------

/** One mebibyte, so the caps below read as the numbers an operator types. */
const MIB = 1_048_576;

/**
 * The ceiling any brand may raise a cap to. A policy is edited by a Team
 * Leader, so it is input, and an input that decides how many bytes a stranger
 * may push into the bucket needs a bound that is not also editable.
 */
export const ATTACHMENT_MAX_BYTES_CEILING = 200 * MIB;

/** At most this many attachments per message, whatever a brand sets. */
export const ATTACHMENTS_PER_MESSAGE_CEILING = 20;

/**
 * A MIME type as a policy may name it: one type, one subtype, no parameters. A
 * wildcard is deliberately not accepted — `image/*` would let a brand allow
 * formats the worker has no encoder for, and the point of the list is that
 * everything on it has a path through the pipeline.
 */
export const mimeTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/,
    'must be a MIME type',
  );

/**
 * One switchable kind of attachment: on or off, a size cap and the MIME types
 * it accepts. The same shape for images, video, voice and files, because
 * REQUIREMENTS §4.6 gives them the same three controls.
 */
export const mediaPolicySchema = z.object({
  enabled: z.boolean(),
  maxBytes: z.int().positive().max(ATTACHMENT_MAX_BYTES_CEILING),
  /** Non-empty: a kind that is enabled with nothing allowed is a kind that is off. */
  allowedMime: z.array(mimeTypeSchema).min(1).max(40),
});
export type MediaPolicy = z.infer<typeof mediaPolicySchema>;

const IMAGE_POLICY: MediaPolicy = {
  enabled: true,
  maxBytes: 10 * MIB,
  allowedMime: ['image/webp', 'image/jpeg', 'image/png', 'image/gif'],
};

const VIDEO_POLICY: MediaPolicy = {
  enabled: true,
  maxBytes: 50 * MIB,
  allowedMime: ['video/mp4', 'video/webm'],
};

/**
 * Voice notes. `audio/webm` and `audio/mp4` are what `MediaRecorder` produces
 * in Chromium and in Safari respectively (REQUIREMENTS §4.6); `audio/ogg` is
 * what the worker normalises all three to.
 */
const VOICE_POLICY: MediaPolicy = {
  enabled: true,
  maxBytes: 5 * MIB,
  allowedMime: ['audio/ogg', 'audio/webm', 'audio/mp4'],
};

/** The two Office formats are named in full because their MIME types are. */
const FILE_POLICY: MediaPolicy = {
  enabled: true,
  maxBytes: 25 * MIB,
  allowedMime: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'application/zip',
  ],
};

export const DEFAULT_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * What a brand allows in a message (REQUIREMENTS §4.6, ARCHITECTURE §9).
 *
 * Every field carries its default, so a brand created before a kind existed —
 * or one whose stored policy is `{}` — parses into a whole policy rather than
 * into a hole somebody has to remember to check. `contentPolicySchema.parse({})`
 * is therefore the shipped default, and {@link DEFAULT_CONTENT_POLICY} is that
 * value.
 *
 * `keepOriginals` is the one switch with a cost attached: with it on, the bytes
 * a stranger uploaded are kept beside the re-encoded copy, which is the whole
 * point and also the thing image re-encoding exists to avoid (REQUIREMENTS
 * §5.1). Off by default.
 */
export const contentPolicySchema = z.object({
  text: z.boolean().default(true),
  emoji: z.boolean().default(true),
  image: mediaPolicySchema.default(IMAGE_POLICY),
  video: mediaPolicySchema.default(VIDEO_POLICY),
  voice: mediaPolicySchema.default(VOICE_POLICY),
  file: mediaPolicySchema.default(FILE_POLICY),
  maxAttachmentsPerMessage: z
    .int()
    .min(0)
    .max(ATTACHMENTS_PER_MESSAGE_CEILING)
    .default(DEFAULT_ATTACHMENTS_PER_MESSAGE),
  keepOriginals: z.boolean().default(false),
});
export type ContentPolicy = z.infer<typeof contentPolicySchema>;

export const DEFAULT_CONTENT_POLICY: ContentPolicy = Object.freeze(contentPolicySchema.parse({}));

/**
 * Which half of the policy governs a kind. `audio` reads `voice`, because
 * REQUIREMENTS §4.6 calls the control "voice messages" and the pipeline calls
 * the bytes audio; naming both is how the two stay one setting.
 */
export const policyFieldFor = (kind: AttachmentKind): 'image' | 'video' | 'voice' | 'file' =>
  kind === 'audio' ? 'voice' : kind;

export const policyFor = (policy: ContentPolicy, kind: AttachmentKind): MediaPolicy =>
  policy[policyFieldFor(kind)];

// --------------------------------------------------------------------------
// Variants
// --------------------------------------------------------------------------

/**
 * Every object that may exist in the bucket for one attachment.
 *
 * `original` is the key the client PUT to. It is listed here with the derived
 * objects rather than treated as a special case, because whether it *survives*
 * depends on the kind and on the brand's `keepOriginals`: a video and a file
 * keep theirs, an image and a voice note are replaced by what this install
 * encoded. Recording it as a variant is what lets a download be a single
 * lookup — the row says which objects exist, so asking for one that does not is
 * a 404 and never a signed URL pointing at nothing.
 */
export const attachmentVariantNameSchema = z.enum([
  /** The bytes as uploaded. Present only when they were kept. */
  'original',
  /** An image re-encoded to WebP, at most 2048 px on its long edge. */
  'webp',
  'thumb320',
  'thumb960',
  /** A video's poster frame, as WebP. */
  'poster',
  /** A voice note normalised to Opus in an Ogg container. */
  'opus',
]);
export type AttachmentVariantName = z.infer<typeof attachmentVariantNameSchema>;

/** The derived objects: everything the worker makes, which is not the upload. */
export const derivedVariantNameSchema = attachmentVariantNameSchema.exclude(['original']);
export type DerivedVariantName = z.infer<typeof derivedVariantNameSchema>;

export const attachmentVariantSchema = z.object({
  mime: mimeTypeSchema,
  size: z.int().nonnegative(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  durationMs: z.int().nonnegative().optional(),
});
export type AttachmentVariant = z.infer<typeof attachmentVariantSchema>;

/**
 * What `attachments.variants` holds: every object that exists for this
 * attachment, keyed by name. A partial record — a PDF has `original` alone, an
 * image whose brand does not keep originals has three WebPs and no `original` —
 * and asking for one a row does not have is a 404 rather than a signed URL
 * pointing at nothing.
 */
export const attachmentVariantsSchema = z.partialRecord(
  attachmentVariantNameSchema,
  attachmentVariantSchema,
);
export type AttachmentVariants = z.infer<typeof attachmentVariantsSchema>;

/** What a download may ask for. The same names, because it asks for an object. */
export const downloadVariantSchema = attachmentVariantNameSchema;
export type DownloadVariant = z.infer<typeof downloadVariantSchema>;

// --------------------------------------------------------------------------
// The attachment
// --------------------------------------------------------------------------

/** Long enough for a real filename, short enough not to be a payload. */
export const ATTACHMENT_NAME_MAX = 255;

/**
 * One attachment, as the api returns it.
 *
 * `s3Key` is deliberately absent: the bucket layout is the server's, a client
 * reaches an object only through a presigned URL this api issued after
 * authorising the parent ticket (DOMAIN-RULES §4.5), and a key in a response is
 * a key in a log and in a screenshot.
 */
export const attachmentSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  /** Null until the message it belongs to is sent. */
  messageId: z.uuid().nullable(),
  uploaderType: attachmentUploaderTypeSchema,
  /** The name as uploaded, stripped of any path ({@link safeFileName}). */
  originalName: z.string().max(ATTACHMENT_NAME_MAX),
  /** What the pipeline decided the bytes are, which may not be what was declared. */
  mime: mimeTypeSchema,
  kind: attachmentKindSchema,
  size: z.int().nonnegative(),
  status: attachmentStatusSchema,
  rejectReason: attachmentRejectReasonSchema.nullable(),
  scanStatus: attachmentScanStatusSchema,
  variants: attachmentVariantsSchema,
  createdAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------

/**
 * What a client asks for before it uploads. Every field is a *claim*: the size
 * and the MIME are checked against the policy here so that a refusal costs no
 * bytes, and checked again against the object and its magic bytes afterwards,
 * because a claim is not evidence (ARCHITECTURE §9).
 */
export const attachmentPresignRequestSchema = z.object({
  kind: attachmentKindSchema,
  mime: mimeTypeSchema,
  /** Bytes the client is about to send. The presigned URL signs exactly this. */
  size: z.int().positive(),
  fileName: z.string().trim().min(1).max(ATTACHMENT_NAME_MAX),
});
export type AttachmentPresignRequest = z.infer<typeof attachmentPresignRequestSchema>;

/**
 * The upload instruction. `headers` must be sent verbatim: they are part of the
 * signature, so a client that adds, drops or rewrites one gets a 403 from the
 * bucket rather than an upload nobody checked the size of.
 */
export const attachmentPresignResponseSchema = z.object({
  attachmentId: z.uuid(),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type AttachmentPresignResponse = z.infer<typeof attachmentPresignResponseSchema>;

/** `GET …/attachments/:id`: the row, and a URL for the variant that was asked for. */
export const attachmentDownloadSchema = z.object({
  attachment: attachmentSchema,
  variant: downloadVariantSchema,
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
export type AttachmentDownload = z.infer<typeof attachmentDownloadSchema>;

export const attachmentDownloadQuerySchema = z.object({
  variant: downloadVariantSchema.default('original'),
});
export type AttachmentDownloadQuery = z.infer<typeof attachmentDownloadQuerySchema>;

export const attachmentParamSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  attachmentId: z.uuid(),
});
export type AttachmentParam = z.infer<typeof attachmentParamSchema>;

// --------------------------------------------------------------------------
// Names
// --------------------------------------------------------------------------

/**
 * A filename with nothing in it that can leave the row it is stored in.
 *
 * Path separators, `..`, control characters and leading dots are removed, so
 * the value can be put in a `Content-Disposition` header and shown in a UI
 * without either of them having to defend itself. The key an object is stored
 * under never contains it at all — the key is built from uuids alone — so this
 * is about what a *person* sees and what a browser saves, not about where the
 * bytes go.
 */
export const safeFileName = (value: string): string => {
  const flattened = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replaceAll('\\', '/')
    .split('/')
    .pop();

  const trimmed = (flattened ?? '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX);

  return trimmed.length > 0 ? trimmed : 'attachment';
};
