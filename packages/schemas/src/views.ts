import { z } from 'zod';
import { ticketListQuerySchema } from './ticket.js';

/**
 * Views (M1-05, REQUIREMENTS §4.1): saved filters over the ticket list,
 * personal or shared, plus the built-in defaults every brand is seeded with.
 *
 * **A view is a list query with a name.** Its filters are
 * {@link ticketListQuerySchema} itself, less the two fields that belong to one
 * read rather than to a queue — the cursor and the page size — so anything the
 * list accepts a view can save, and a view can never ask for something the list
 * does not understand. There is one schema, not two that could drift.
 *
 * **A view never widens access.** Resolving one produces list parameters, and
 * those go through the same department-scoped read as a query typed by hand: a
 * view shared with Billing shows a Support agent nothing they could not already
 * see.
 */

export const ticketViewFiltersSchema = ticketListQuerySchema.omit({ cursor: true, limit: true });
/** What is stored and returned: the defaults filled in. */
export type TicketViewFilters = z.infer<typeof ticketViewFiltersSchema>;
/** What a client sends: `sort` and `direction` may be left to their defaults. */
export type TicketViewFiltersInput = z.input<typeof ticketViewFiltersSchema>;

/**
 * The five defaults of REQUIREMENTS §4.1. `department_open` is "All open" for
 * one department, and there is one of it per department of the brand: it
 * appears when a department is created and goes when it is deleted.
 */
export const ticketViewBuiltInSchema = z.enum([
  'my_open',
  'unassigned',
  'overdue',
  'department_open',
  'escalated',
]);
export type TicketViewBuiltIn = z.infer<typeof ticketViewBuiltInSchema>;

export const VIEW_NAME_MAX_LENGTH = 80;
/** The most views one list holds: a brand's shared views, or one person's own. */
export const MAX_VIEWS_PER_LIST = 200;
/**
 * A sidebar count stops here and reads "999+". Counting further would read
 * every matching ticket, and nobody triages a queue by whether it holds a
 * thousand or four thousand.
 */
export const VIEW_COUNT_CAP = 999;

const viewNameSchema = z.string().trim().min(1).max(VIEW_NAME_MAX_LENGTH);

/**
 * Who sees a view. `personal` is its owner alone, under "Mine". `brand` is
 * everybody in the brand. `departments` is the staff whose scope reaches at
 * least one of them — and it is visibility of the *view*, not of tickets.
 */
export const ticketViewVisibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }),
  z.object({ kind: z.literal('brand') }),
  z.object({
    kind: z.literal('departments'),
    departmentIds: z.array(z.uuid()).min(1).max(50),
  }),
]);
export type TicketViewVisibility = z.infer<typeof ticketViewVisibilitySchema>;

export const ticketViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nameAr: z.string().nullable(),
  visibility: ticketViewVisibilitySchema,
  /** Null for a view somebody saved; the key of a seeded default otherwise. */
  builtIn: ticketViewBuiltInSchema.nullable(),
  /** The department a `department_open` view is for; null for every other view. */
  departmentId: z.uuid().nullable(),
  filters: ticketViewFiltersSchema,
  /** A shared view the brand has hidden from the sidebar. Always false for a personal one. */
  hidden: z.boolean(),
  sortOrder: z.int(),
  /** Whether the reader may change it: their own, or a shared one they manage. */
  editable: z.boolean(),
});
export type TicketView = z.infer<typeof ticketViewSchema>;

/** Shared views first in the brand's order, then the reader's own in theirs. */
export const ticketViewListSchema = z.object({ views: z.array(ticketViewSchema) });
export type TicketViewList = z.infer<typeof ticketViewListSchema>;

export const ticketViewCountSchema = z.object({
  viewId: z.uuid(),
  /** Tickets the reader can see that match, up to {@link VIEW_COUNT_CAP}. */
  count: z.int().nonnegative(),
  /** True when there are more than `count`, so the sidebar prints "999+". */
  capped: z.boolean(),
});
export type TicketViewCount = z.infer<typeof ticketViewCountSchema>;

/** One count per view in the sidebar: every visible view except the hidden ones. */
export const ticketViewCountListSchema = z.object({ counts: z.array(ticketViewCountSchema) });
export type TicketViewCountList = z.infer<typeof ticketViewCountListSchema>;

export const ticketViewCreateRequestSchema = z.object({
  name: viewNameSchema,
  nameAr: viewNameSchema.nullish(),
  filters: ticketViewFiltersSchema,
  visibility: ticketViewVisibilitySchema.default({ kind: 'personal' }),
});
export type TicketViewCreateRequest = z.infer<typeof ticketViewCreateRequestSchema>;
export type TicketViewCreateInput = z.input<typeof ticketViewCreateRequestSchema>;

/**
 * Every field optional, at least one present. A built-in view accepts `name`,
 * `nameAr` and `hidden` only; the other two are refused with
 * `view-is-built-in` rather than ignored.
 */
export const ticketViewUpdateRequestSchema = z
  .object({
    name: viewNameSchema.optional(),
    nameAr: viewNameSchema.nullable().optional(),
    filters: ticketViewFiltersSchema.optional(),
    visibility: ticketViewVisibilitySchema.optional(),
    hidden: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type TicketViewUpdateRequest = z.infer<typeof ticketViewUpdateRequestSchema>;
export type TicketViewUpdateInput = z.input<typeof ticketViewUpdateRequestSchema>;

/**
 * A new order for some views: all of them shared, or all of them the reader's
 * own. They take the places they held between them, in the order given, so a
 * Team Leader can reorder the views they manage without naming the ones they
 * do not.
 */
export const ticketViewReorderRequestSchema = z.object({
  viewIds: z.array(z.uuid()).min(1).max(MAX_VIEWS_PER_LIST),
});
export type TicketViewReorderRequest = z.infer<typeof ticketViewReorderRequestSchema>;

export const ticketViewParamSchema = z.object({
  brandId: z.uuid(),
  viewId: z.uuid(),
});
export type TicketViewParam = z.infer<typeof ticketViewParamSchema>;
