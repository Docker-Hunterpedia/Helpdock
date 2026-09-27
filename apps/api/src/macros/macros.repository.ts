import {
  brands,
  type CannedResponse,
  cannedResponses,
  contacts,
  type DbTransaction,
  departments,
  type NewCannedResponse,
  tags,
  teams,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
} from '@helpdock/db';
import type { MacroKind, MacroLocale } from '@helpdock/schemas';
import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';

/**
 * Every statement the macro endpoints make (M3-06).
 *
 * None filters by brand or by owner: the transaction carries `app.brand_ids`
 * and `app.principal_id`, and the two policies on `canned_responses` apply
 * them — somebody else's personal item is not a row this transaction can read.
 * Which *shared* items a reader is offered is the service's rule
 * (`macro-rules.ts`), because it is about departments.
 */
export class MacrosRepository {
  async list(
    tx: DbTransaction,
    filter: { readonly kind?: MacroKind | undefined; readonly q?: string | undefined },
  ): Promise<CannedResponse[]> {
    const conditions = [
      filter.kind === undefined ? undefined : eq(cannedResponses.kind, filter.kind),
      filter.q === undefined || filter.q === ''
        ? undefined
        : or(
            ilike(cannedResponses.name, `%${escapeLike(filter.q)}%`),
            ilike(sql`${cannedResponses.bodies}::text`, `%${escapeLike(filter.q)}%`),
          ),
    ].filter((condition) => condition !== undefined);

    return tx
      .select()
      .from(cannedResponses)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(cannedResponses.name), asc(cannedResponses.id));
  }

  /** Undefined for another brand's item, and for somebody else's personal one. */
  async find(tx: DbTransaction, id: string): Promise<CannedResponse | undefined> {
    const rows = await tx.select().from(cannedResponses).where(eq(cannedResponses.id, id)).limit(1);

    return rows[0];
  }

  async count(tx: DbTransaction): Promise<number> {
    const [row] = await tx.select({ value: count() }).from(cannedResponses);

    return row?.value ?? 0;
  }

  async create(tx: DbTransaction, values: NewCannedResponse): Promise<CannedResponse> {
    const [row] = await tx.insert(cannedResponses).values(values).returning();
    /* c8 ignore next 3 -- an insert that did not throw returned its row. */
    if (row === undefined) {
      throw new Error('The insert returned no row');
    }

    return row;
  }

  async update(
    tx: DbTransaction,
    id: string,
    values: Partial<NewCannedResponse>,
  ): Promise<CannedResponse | undefined> {
    const [row] = await tx
      .update(cannedResponses)
      .set(values)
      .where(eq(cannedResponses.id, id))
      .returning();

    return row;
  }

  async remove(tx: DbTransaction, id: string): Promise<void> {
    await tx.delete(cannedResponses).where(eq(cannedResponses.id, id));
  }

  /** "Last used" on the list. Not `updated_at`: using an item is not editing it. */
  async touchUsed(tx: DbTransaction, id: string, at: Date): Promise<void> {
    await tx
      .update(cannedResponses)
      .set({ lastUsedAt: at, updatedAt: sql`${cannedResponses.updatedAt}` })
      .where(eq(cannedResponses.id, id));
  }

  /** A staff member's name. `users` is global, so it is read by id. */
  async staffName(tx: DbTransaction, userId: string): Promise<string | null> {
    const rows = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return rows[0]?.name ?? null;
  }

  async departmentExists(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Whether every id an action names is this brand's. Each table is brand-scoped
   * by its own policy, so an id of another brand is simply not found.
   */
  async referencesExist(
    tx: DbTransaction,
    refs: {
      readonly statusIds: readonly string[];
      readonly tagIds: readonly string[];
      readonly userIds: readonly string[];
      readonly teamIds: readonly string[];
    },
  ): Promise<boolean> {
    const found = async (
      ids: readonly string[],
      read: (unique: string[]) => Promise<readonly unknown[]>,
    ): Promise<boolean> => {
      const unique = [...new Set(ids)];

      return unique.length === 0 || (await read(unique)).length === unique.length;
    };

    // One after another: the statements share the request's connection.
    return (
      (await found(refs.statusIds, (ids) =>
        tx
          .select({ id: ticketStatuses.id })
          .from(ticketStatuses)
          .where(inArray(ticketStatuses.id, ids)),
      )) &&
      (await found(refs.tagIds, (ids) =>
        tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, ids)),
      )) &&
      (await found(refs.teamIds, (ids) =>
        tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, ids)),
      )) &&
      (await found(refs.userIds, (ids) =>
        tx
          .selectDistinct({ id: userBrandRoles.userId })
          .from(userBrandRoles)
          .where(inArray(userBrandRoles.userId, ids)),
      ))
    );
  }
}

/** What filling a reply in for one ticket reads, beyond what `TemplatesRepository.subject` does. */
export interface RenderTicket {
  readonly brandId: string;
  readonly departmentId: string;
  readonly reference: string;
  readonly contactId: string | null;
  /** The contact's language, then the brand's: who the reply is written to. */
  readonly locale: MacroLocale;
  /** The assignee's name, which a reply sent by a rule signs with. */
  readonly assigneeName: string | null;
}

/**
 * The ticket a reply is being filled in for, or undefined when this transaction
 * cannot read it — another brand's, or another department's.
 *
 * `brands` and `users` are global tables, so they are joined by the ticket's
 * own ids rather than filtered by a policy; the ticket row itself is what the
 * policies decide on.
 */
export const readRenderTicket = async (
  tx: DbTransaction,
  ticketId: string,
): Promise<RenderTicket | undefined> => {
  const rows = await tx
    .select({
      brandId: tickets.brandId,
      departmentId: tickets.departmentId,
      prefix: tickets.prefix,
      number: tickets.number,
      contactId: tickets.contactId,
      contactLocale: contacts.locale,
      brandLocale: brands.defaultLocale,
      assigneeName: users.name,
    })
    .from(tickets)
    .innerJoin(brands, eq(brands.id, tickets.brandId))
    .leftJoin(contacts, eq(contacts.id, tickets.contactId))
    .leftJoin(users, eq(users.id, tickets.assigneeId))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    brandId: row.brandId,
    departmentId: row.departmentId,
    reference: `${row.prefix}-${String(row.number)}`,
    contactId: row.contactId,
    locale: row.contactLocale ?? row.brandLocale,
    assigneeName: row.assigneeName,
  };
};

/** `%` and `_` typed into the search box are characters, not wildcards. */
const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);
