import { z } from 'zod';

/**
 * Tags (M1-06): the labels a brand puts on its tickets, and what a chip is
 * drawn from.
 *
 * Two shapes, deliberately. {@link tagSchema} is what a ticket carries — the
 * four things a chip needs and nothing else — so a ticket list of fifty rows
 * does not ship a ticket count per chip per row. {@link tagSummarySchema} adds
 * what the settings tab prints, and only that route answers with it.
 */

/**
 * The eight tints of DESIGN §6.2. The danger tint is absent on purpose: red
 * means "breached" or "destructive" on this desk, and a tag a brand invents
 * must never be able to claim it. `sand`, `stone`, `clay` and `bark` are the
 * four warm neutrals, in order of how dark they are.
 */
export const tagColorSchema = z.enum([
  'info',
  'success',
  'warning',
  'escalated',
  'sand',
  'stone',
  'clay',
  'bark',
]);
export type TagColor = z.infer<typeof tagColorSchema>;

export const TAG_NAME_MAX_LENGTH = 60;
export const MAX_TAGS_PER_BRAND = 500;
/** How many chips a row draws before the rest collapse into "+n" (DESIGN §6.2). */
export const TAG_OVERFLOW_AFTER = 3;

const tagNameSchema = z.string().trim().min(1).max(TAG_NAME_MAX_LENGTH);

/** One chip: what a ticket row and the details panel draw. */
export const tagSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(TAG_NAME_MAX_LENGTH),
  /** Arabic label. Null falls back to `name`, as a department's does. */
  nameAr: z.string().min(1).max(TAG_NAME_MAX_LENGTH).nullable(),
  color: tagColorSchema,
});
export type Tag = z.infer<typeof tagSchema>;

/** One row of the Tags tab. The count is the api's, for the reason a department's is. */
export const tagSummarySchema = tagSchema.extend({
  sortOrder: z.int().nonnegative(),
  ticketCount: z.int().nonnegative(),
});
export type TagSummary = z.infer<typeof tagSummarySchema>;

export const tagListSchema = z.object({ tags: z.array(tagSummarySchema) });
export type TagList = z.infer<typeof tagListSchema>;

export const tagCreateRequestSchema = z.object({
  name: tagNameSchema,
  nameAr: tagNameSchema.nullish(),
  color: tagColorSchema.default('sand'),
});
export type TagCreateRequest = z.infer<typeof tagCreateRequestSchema>;

export const tagUpdateRequestSchema = z
  .object({
    name: tagNameSchema.optional(),
    nameAr: tagNameSchema.nullable().optional(),
    color: tagColorSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type TagUpdateRequest = z.infer<typeof tagUpdateRequestSchema>;

/** The whole list in its new order, as departments are reordered and for the same reason. */
export const tagReorderRequestSchema = z.object({
  tagIds: z.array(z.uuid()).min(1).max(MAX_TAGS_PER_BRAND),
});
export type TagReorderRequest = z.infer<typeof tagReorderRequestSchema>;

/**
 * How many tickets carry a tag, read before the delete confirmation so the
 * dialog can say "12 tickets keep no tag" rather than asking blind. Deleting a
 * tag detaches it; it never touches the tickets themselves.
 */
export const tagUsageSchema = z.object({
  tagId: z.uuid(),
  ticketCount: z.int().nonnegative(),
});
export type TagUsage = z.infer<typeof tagUsageSchema>;

export const tagParamSchema = z.object({
  brandId: z.uuid(),
  tagId: z.uuid(),
});
export type TagParam = z.infer<typeof tagParamSchema>;

/**
 * The whole set of tags a ticket should carry afterwards. A replace rather than
 * add/remove calls: it is idempotent, it is one activity row instead of four,
 * and two agents editing at once end at one of the two sets rather than at a
 * mixture of both.
 */
export const ticketTagsRequestSchema = z.object({
  tagIds: z.array(z.uuid()).max(MAX_TAGS_PER_BRAND),
});
export type TicketTagsRequest = z.infer<typeof ticketTagsRequestSchema>;

export const ticketTagListSchema = z.object({ tags: z.array(tagSchema) });
export type TicketTagList = z.infer<typeof ticketTagListSchema>;
