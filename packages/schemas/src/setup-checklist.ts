import { z } from 'zod';

/**
 * M14-13: the "Get set up" checklist an Admin sees at the foot of the sidebar.
 *
 * The order is the order of the panel. Steps are computed from the brand's own
 * data when the checklist is read and are never stored as ticked; the only
 * thing a person can change is hiding it. The api sends ids, not links or
 * words: the admin app owns the route of each step and its translated copy.
 */
export const SETUP_CHECKLIST_STEPS = [
  'channel',
  'teammate',
  'businessHours',
  'slaPolicy',
  'assignment',
  'reply',
  'article',
  'aiProvider',
  'firstTicket',
] as const;
export const setupChecklistStepIdSchema = z.enum(SETUP_CHECKLIST_STEPS);
export type SetupChecklistStepId = z.infer<typeof setupChecklistStepIdSchema>;

/** The one step the brand may leave undone and still be set up. */
export const OPTIONAL_SETUP_CHECKLIST_STEPS: readonly SetupChecklistStepId[] = ['aiProvider'];

export const setupChecklistStepSchema = z.object({
  id: setupChecklistStepIdSchema,
  done: z.boolean(),
  optional: z.boolean(),
});
export type SetupChecklistStep = z.infer<typeof setupChecklistStepSchema>;

export const setupChecklistSchema = z.object({
  steps: z.array(setupChecklistStepSchema),
  /** Steps done, optional ones included: the "3 of 9" the panel prints. */
  doneCount: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  /** Every required step is done: the checklist hides itself for everyone. */
  complete: z.boolean(),
  /** The reader hid it for this brand. */
  dismissed: z.boolean(),
});
export type SetupChecklist = z.infer<typeof setupChecklistSchema>;
