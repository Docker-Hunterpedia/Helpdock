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
import { and, asc, count, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';

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

  /**
   * Serialises saves that use one shortcut word in one brand until the
   * transaction ends. Two saves in different scopes (a department's and the
   * whole brand's) are not covered by any one unique index.
   */
  async lockShortcut(tx: DbTransaction, brandId: string, shortcut: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${brandId} || ':' || ${shortcut.toLowerCase()}, 0))`,
    );
  }

  /** The items this transaction can read that answer to `shortcut`, other than `exceptId`. */
  async withShortcut(
    tx: DbTransaction,
    shortcut: string,
    exceptId: string | null,
  ): Promise<CannedResponse[]> {
    return tx
      .select()
      .from(cannedResponses)
      .where(
        and(
          eq(cannedResponses.shortcut, shortcut),
          exceptId === null ? undefined : ne(cannedResponses.id, exceptId),
        ),
      );
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

  /** "Last used" and the use count on the list. Not `updated_at`: using an item is not editing it. */
  async touchUsed(tx: DbTransaction, id: string, at: Date): Promise<void> {
    await tx
      .update(cannedResponses)
      .set({
        lastUsedAt: at,
        useCount: sql`${cannedResponses.useCount} + 1`,
        updatedAt: sql`${cannedResponses.updatedAt}`,
      })
      .where(eq(cannedResponses.id, id));
  }

  /**
   * A staff member as a reply's `agent.*` placeholders need them (M14-12).
   * `users` is global, so it is read by id.
   */
  async staffIdentity(tx: DbTransaction, userId: string): Promise<RenderAgent | null> {
    const rows = await tx
      .select(renderAgentColumns)
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return rows[0] ?? null;
  }

  async departmentExists(tx: DbTransaction, departmentId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.id, departmentId))
      .limit(1);

    return rows.length > 0;
  }

  /** Whether any of these statuses is Snoozed, which a macro cannot set (it needs a wake time). */
  async includesSnoozed(tx: DbTransaction, ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) {
      return false;
    }
    const rows = await tx
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(and(inArray(ticketStatuses.id, [...ids]), eq(ticketStatuses.systemKey, 'snoozed')))
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

/** Who sends a reply, with what the placeholders can say about them. */
export interface RenderAgent {
  readonly name: string;
  readonly publicName: string | null;
  readonly jobTitleEn: string | null;
  readonly jobTitleAr: string | null;
  readonly phone: string | null;
}

const renderAgentColumns = {
  name: users.name,
  publicName: users.publicName,
  jobTitleEn: users.jobTitleEn,
  jobTitleAr: users.jobTitleAr,
  phone: users.publicPhone,
} as const;

/** What filling a reply in for one ticket reads, beyond what `TemplatesRepository.subject` does. */
export interface RenderTicket {
  readonly brandId: string;
  readonly departmentId: string;
  readonly reference: string;
  readonly contactId: string | null;
  /** The contact's language, then the brand's: who the reply is written to. */
  readonly locale: MacroLocale;
  /** The department's name in `locale`, for `{{department.name}}`. */
  readonly departmentName: string;
  /** The assignee, whom a reply sent by a rule speaks as. */
  readonly assignee: RenderAgent | null;
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
      departmentName: departments.name,
      departmentNameAr: departments.nameAr,
      assigneeId: users.id,
      ...renderAgentColumns,
    })
    .from(tickets)
    .innerJoin(brands, eq(brands.id, tickets.brandId))
    .innerJoin(departments, eq(departments.id, tickets.departmentId))
    .leftJoin(contacts, eq(contacts.id, tickets.contactId))
    .leftJoin(users, eq(users.id, tickets.assigneeId))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  const locale: MacroLocale = row.contactLocale ?? row.brandLocale;

  return {
    brandId: row.brandId,
    departmentId: row.departmentId,
    reference: `${row.prefix}-${String(row.number)}`,
    contactId: row.contactId,
    locale,
    departmentName:
      locale === 'ar' && row.departmentNameAr !== null ? row.departmentNameAr : row.departmentName,
    assignee:
      row.assigneeId === null
        ? null
        : {
            name: row.name ?? '',
            publicName: row.publicName,
            jobTitleEn: row.jobTitleEn,
            jobTitleAr: row.jobTitleAr,
            phone: row.phone,
          },
  };
};

/** `%` and `_` typed into the search box are characters, not wildcards. */
const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);
