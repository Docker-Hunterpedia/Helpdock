import { z } from 'zod';
import { contactIdentitySchema, contactIdParamSchema } from './contact.js';

/**
 * Merging two contacts by hand, and taking it back (M1-13, DOMAIN-RULES §4.4).
 *
 * The contact in the path is the **survivor**: its name and details are kept,
 * and the other contact's identifiers, tickets and notes move onto it. The
 * dialog's "Keep the name and details of" radio therefore decides which of the
 * two paths the screen posts to.
 */

export const contactMergeRequestSchema = z.object({
  /** The contact folded into the one in the path. */
  mergedContactId: z.uuid(),
  /** The suggestion the merge was made from, if it was; it is marked `merged`. */
  suggestionId: z.uuid().optional(),
});
export type ContactMergeRequest = z.infer<typeof contactMergeRequestSchema>;

export const contactMergeParamSchema = contactIdParamSchema.extend({ mergeId: z.uuid() });
export type ContactMergeParam = z.infer<typeof contactMergeParamSchema>;

export const contactMergePreviewQuerySchema = z.object({ otherContactId: z.uuid() });
export type ContactMergePreviewQuery = z.infer<typeof contactMergePreviewQuerySchema>;

/** One side of the dialog's "Keep the name and details of" choice. */
export const contactMergeSideSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  accountName: z.string().nullable(),
  /**
   * Every ticket of the contact, **including the ones in departments the viewer
   * is not in**: they move with the merge too, and DOMAIN-RULES §1.2 lets a
   * count of hidden tickets be shown where their content may not.
   */
  ticketCount: z.int().nonnegative(),
});
export type ContactMergeSide = z.infer<typeof contactMergeSideSchema>;

/**
 * What the merge dialog draws before anything is changed: both sides, and the
 * union of their identifiers as they will be afterwards. Each identifier keeps
 * its own `verified` flag — verification never upgrades by merging.
 */
export const contactMergePreviewSchema = z.object({
  contact: contactMergeSideSchema,
  other: contactMergeSideSchema,
  identities: z.array(contactIdentitySchema.extend({ contactId: z.uuid() })),
});
export type ContactMergePreview = z.infer<typeof contactMergePreviewSchema>;
