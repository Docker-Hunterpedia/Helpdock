import { z } from 'zod';
import { customFieldKeySchema, customFieldTypeSchema } from './custom-fields.js';
import { captchaProviderSchema } from './widget-settings.js';

/**
 * The hosted web form per brand (M4-09, REQUIREMENTS §4.4): what Channels ›
 * Web form reads and saves, and the limits the public page holds a
 * submission to.
 *
 * A field of the form is named by a **reference**: one of the four built-in
 * fields by its name, or a ticket custom field as `custom:<key>`. The key is
 * the custom field's immutable one, and `customFieldKeySchema` has no colon in
 * its alphabet, so the two spellings can never collide.
 */

export const WEB_FORM_BUILTIN_FIELDS = ['name', 'email', 'subject', 'message'] as const;
export type WebFormBuiltinField = (typeof WEB_FORM_BUILTIN_FIELDS)[number];

/** Always shown and always required: the address we reply to, and what the customer wants. */
export const WEB_FORM_LOCKED_FIELDS: readonly WebFormBuiltinField[] = ['email', 'message'];

export const CUSTOM_FIELD_REF_PREFIX = 'custom:';

export const customFieldRef = (key: string): string => `${CUSTOM_FIELD_REF_PREFIX}${key}`;

/** The custom field key a reference names, or null for a built-in field. */
export const customKeyOfRef = (ref: string): string | null =>
  ref.startsWith(CUSTOM_FIELD_REF_PREFIX) ? ref.slice(CUSTOM_FIELD_REF_PREFIX.length) : null;

export const isBuiltinField = (ref: string): ref is WebFormBuiltinField =>
  (WEB_FORM_BUILTIN_FIELDS as readonly string[]).includes(ref);

export const webFormFieldRefSchema = z.union([
  z.enum(WEB_FORM_BUILTIN_FIELDS),
  z
    .string()
    .startsWith(CUSTOM_FIELD_REF_PREFIX)
    .refine(
      (ref) => customFieldKeySchema.safeParse(customKeyOfRef(ref)).success,
      'A custom field reference is custom:<key>',
    ),
]);

/** Lengths the public page holds a submission to. The subject matches `tickets.subject`. */
export const WEB_FORM_NAME_MAX = 200;
export const WEB_FORM_EMAIL_MAX = 254;
export const WEB_FORM_SUBJECT_MAX = 500;
export const WEB_FORM_MESSAGE_MAX = 20_000;
export const WEB_FORM_THANK_YOU_MAX = 1000;
/** A form never asks for more files than this, whatever the brand's content policy allows. */
export const WEB_FORM_MAX_FILES = 5;
/** The one placeholder a thank-you message may carry; it becomes the ticket reference. */
export const WEB_FORM_REFERENCE_PLACEHOLDER = '{{ticket.number}}';

/** How a field is drawn: the built-in ones by their own kind, a custom one by its type. */
export const webFormFieldTypeSchema = z.union([
  z.enum(['name', 'email', 'subject', 'long_text']),
  customFieldTypeSchema,
]);
export type WebFormFieldType = z.infer<typeof webFormFieldTypeSchema>;

export const webFormFieldSchema = z.object({
  field: webFormFieldRefSchema,
  kind: z.enum(['builtin', 'custom']),
  /** A custom field's label; empty for a built-in field, which the screen names itself. */
  label: z.string(),
  labelAr: z.string().nullable(),
  type: webFormFieldTypeSchema,
  shown: z.boolean(),
  required: z.boolean(),
  /** Email and Message: always shown and always required. */
  locked: z.boolean(),
});
export type WebFormField = z.infer<typeof webFormFieldSchema>;

export const webFormThankYouSchema = z.object({
  en: z.string().trim().min(1).max(WEB_FORM_THANK_YOU_MAX),
  ar: z.string().trim().min(1).max(WEB_FORM_THANK_YOU_MAX),
});
export type WebFormThankYou = z.infer<typeof webFormThankYouSchema>;

/** Channels › Web form, as the api returns it. */
export const webFormSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Where the form is served: the brand's help center host, or the install's own. */
  publicUrl: z.url(),
  /** Null: the brand's default department. */
  departmentId: z.uuid().nullable(),
  captcha: z.object({
    enabled: z.boolean(),
    /** Whether the brand has keys on the Widget tab. On without keys, the form takes nothing. */
    ready: z.boolean(),
    provider: captchaProviderSchema.nullable(),
  }),
  /** Resolved: the brand's own wording, or the catalog's default in that language. */
  thankYou: webFormThankYouSchema,
  fields: z.array(webFormFieldSchema),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type WebFormSettings = z.infer<typeof webFormSettingsSchema>;

export const webFormFieldUpdateSchema = z.object({
  field: webFormFieldRefSchema,
  shown: z.boolean(),
  required: z.boolean(),
});
export type WebFormFieldUpdate = z.infer<typeof webFormFieldUpdateSchema>;

/**
 * The whole form, in the order its fields are drawn. The api checks what a
 * schema cannot: every built-in field appears once, every custom field
 * exists, and the locked two stay shown and required.
 */
export const webFormSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  departmentId: z.uuid().nullable(),
  captchaEnabled: z.boolean(),
  thankYou: webFormThankYouSchema,
  fields: z.array(webFormFieldUpdateSchema).min(WEB_FORM_BUILTIN_FIELDS.length).max(104),
});
export type WebFormSettingsUpdate = z.infer<typeof webFormSettingsUpdateSchema>;

export const webFormBrandParamSchema = z.object({ brandId: z.uuid() });
export type WebFormBrandParam = z.infer<typeof webFormBrandParamSchema>;

/** `/contact/<brandId>` on the install's own host, for a brand with no help center domain yet. */
export const webFormPageParamSchema = z.object({ brandId: z.uuid() });
export type WebFormPageParam = z.infer<typeof webFormPageParamSchema>;

export const webFormPageQuerySchema = z.object({
  /** A shipped locale picks the page's language; anything else falls back to the brand's. */
  lang: z.string().max(10).optional(),
  /**
   * M5-08: the help center article "Still need help?" came from. Checked as a
   * uuid by the page, which drops anything else rather than refusing the form.
   */
  article: z.string().max(64).optional(),
});
export type WebFormPageQuery = z.infer<typeof webFormPageQuerySchema>;

/**
 * Why a field of a submission was refused. The page picks a sentence per code
 * in the customer's language; nothing a customer reads is built from input.
 */
export const webFormFieldErrorSchema = z.enum([
  'required',
  'email',
  'too_long',
  'invalid',
  'too_many_files',
  'file_too_large',
  'file_type',
]);
export type WebFormFieldError = z.infer<typeof webFormFieldErrorSchema>;

/** Why a whole submission was refused, before or instead of its fields. */
export const webFormFormErrorSchema = z.enum([
  'captcha',
  'rate_limited',
  'rejected',
  'unavailable',
  'failed',
]);
export type WebFormFormError = z.infer<typeof webFormFormErrorSchema>;
