import { z } from 'zod';
import { GraphApiFailure, redactToken } from './errors.js';

/**
 * What Graph answers to the calls Helpdock makes (M10-01), as Zod schemas: a
 * response is input like any other, and every caller reads it through one of
 * these rather than trusting its shape. Loose, for the reason the webhook's are.
 */

/** Ids are strings on the wire, but Graph sometimes writes one as a number. */
const idSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

/**
 * The id of what a send created: WhatsApp's `messages[0].id` (`wamid.…`) or
 * Messenger's and Instagram's `message_id` (`mid`).
 */
export const graphSendResponseSchema = z.union([
  z
    .looseObject({ messages: z.array(z.looseObject({ id: z.string().min(1) })).min(1) })
    .transform((body) => body.messages[0]?.id ?? ''),
  z.looseObject({ message_id: z.string().min(1) }).transform((body) => body.message_id),
]);

/** `POST /{phone-number-id}/media`: the id to send the file by. */
export const graphMediaUploadSchema = z.looseObject({ id: idSchema });

/** `GET /{media-id}`: where the bytes are for the next five minutes. */
export const graphMediaMetaSchema = z.looseObject({
  id: idSchema,
  url: z.url({ protocol: /^https?$/ }),
  mime_type: z.string().optional(),
  /** Hex on this endpoint; the webhook's is base64. */
  sha256: z.string().optional(),
  file_size: z.union([z.string(), z.number()]).optional(),
});
export type GraphMediaMeta = z.infer<typeof graphMediaMetaSchema>;

/**
 * `GET /{id}?fields=…` and `GET /me`: who a token and an id belong to. A
 * WhatsApp number has `verified_name` and `display_phone_number`, a Page a
 * `name`, an Instagram account a `username` and a `name`.
 */
export const graphIdentitySchema = z.looseObject({
  id: idSchema,
  name: z.string().optional(),
  username: z.string().optional(),
  verified_name: z.string().optional(),
  display_phone_number: z.string().optional(),
});
export type GraphIdentity = z.infer<typeof graphIdentitySchema>;

/** The fields `GET /{id}` is asked for, per platform. */
export const GRAPH_IDENTITY_FIELDS = {
  whatsapp: 'id,display_phone_number,verified_name',
  messenger: 'id,name',
  instagram: 'id,username,name',
} as const;

/** The name to show for an identity, whichever field the platform keeps it in. */
export const graphIdentityName = (identity: GraphIdentity): string =>
  identity.verified_name ?? identity.name ?? identity.username ?? identity.id;

const subscribedAppSchema = z.looseObject({
  id: idSchema.optional(),
  name: z.string().optional(),
  subscribed_fields: z.array(z.string()).optional(),
  // WhatsApp wraps the app in its own object.
  whatsapp_business_api_data: z
    .looseObject({ id: idSchema, name: z.string().optional() })
    .optional(),
});

export const graphSubscribedAppsSchema = z.looseObject({ data: z.array(subscribedAppSchema) });

/** One app subscribed to an account's webhooks. */
export interface GraphSubscribedApp {
  readonly id: string;
  readonly name: string | null;
  /** Empty for WhatsApp, which subscribes the whole `messages` field. */
  readonly subscribedFields: readonly string[];
}

/** `GET /{id}/subscribed_apps` in one shape, whichever platform answered. */
export const subscribedAppsOf = (
  body: z.infer<typeof graphSubscribedAppsSchema>,
): GraphSubscribedApp[] =>
  body.data.flatMap((app) => {
    const id = app.whatsapp_business_api_data?.id ?? app.id;
    return id === undefined
      ? []
      : [
          {
            id,
            name: app.whatsapp_business_api_data?.name ?? app.name ?? null,
            subscribedFields: app.subscribed_fields ?? [],
          },
        ];
  });

/** `GET /debug_token`: whether a token works, and until when. */
export const graphDebugTokenSchema = z.looseObject({
  data: z.looseObject({
    is_valid: z.boolean().optional(),
    /** Unix seconds; 0 for a token that does not expire. */
    expires_at: z.number().optional(),
    type: z.string().optional(),
    app_id: idSchema.optional(),
    scopes: z.array(z.string()).optional(),
    error: z
      .looseObject({ code: z.number().optional(), message: z.string().optional() })
      .optional(),
  }),
});
export type GraphDebugToken = z.infer<typeof graphDebugTokenSchema>;

/** `GET /refresh_access_token`: an Instagram token good for another 60 days. */
export const graphRefreshTokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});
export type GraphRefreshToken = z.infer<typeof graphRefreshTokenSchema>;

/**
 * Reads a response through its schema. A body that does not fit is a
 * {@link GraphApiFailure} of kind `permanent`: asking again would get the same
 * shape, and the detail says so without quoting the body.
 */
export const parseGraph = <TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
  what: string,
  ...tokens: readonly (string | undefined)[]
): z.infer<TSchema> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new GraphApiFailure(
      'permanent',
      redactToken(`Graph answered ${what} in a shape Helpdock does not know`, ...tokens),
    );
  }

  return parsed.data;
};
