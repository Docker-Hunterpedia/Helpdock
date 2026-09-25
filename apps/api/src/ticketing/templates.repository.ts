import {
  brands,
  contactIdentities,
  contacts,
  type DbTransaction,
  type NewTicketTemplate,
  type TicketTemplate as TemplateRow,
  ticketTemplates,
} from '@helpdock/db';
import { and, asc, eq, sql } from 'drizzle-orm';

/**
 * Every statement the ticket template endpoints make.
 *
 * Nothing filters by brand: the transaction carries `app.brand_ids` and the
 * policy on `ticket_templates` applies it. The one exception is `brands`, which
 * is a global table with no policy, so the read of a brand's name for the
 * preview names its id explicitly — the same exception `TicketRepository` makes
 * for the ticket prefix.
 */

export interface TemplateSubjectRow {
  readonly brandName: string;
  readonly contact: { readonly name: string; readonly email: string | null } | undefined;
}

export class TemplatesRepository {
  async list(tx: DbTransaction): Promise<TemplateRow[]> {
    const rows = await tx.select().from(ticketTemplates).orderBy(asc(ticketTemplates.name));

    return rows;
  }

  /** Undefined when the id is not this brand's, which the policy decides. */
  async find(tx: DbTransaction, templateId: string): Promise<TemplateRow | undefined> {
    const rows = await tx
      .select()
      .from(ticketTemplates)
      .where(eq(ticketTemplates.id, templateId))
      .limit(1);

    return rows[0];
  }

  async create(tx: DbTransaction, values: NewTicketTemplate): Promise<TemplateRow> {
    const rows = await tx.insert(ticketTemplates).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The ticket template insert returned no row');
    }

    return row;
  }

  async update(
    tx: DbTransaction,
    templateId: string,
    values: Partial<NewTicketTemplate>,
  ): Promise<TemplateRow | undefined> {
    const rows = await tx
      .update(ticketTemplates)
      .set(values)
      .where(eq(ticketTemplates.id, templateId))
      .returning();

    return rows[0];
  }

  async delete(tx: DbTransaction, templateId: string): Promise<void> {
    await tx.delete(ticketTemplates).where(eq(ticketTemplates.id, templateId));
  }

  /**
   * One more ticket made from this template.
   *
   * `usage_count + 1` in SQL rather than a read followed by a write, so two
   * tickets filed in the same instant count as two. Written as a statement
   * rather than through the ORM's `update` so that `updated_at` stays where it
   * is: a template nobody edited has not changed, and "last edited" is what the
   * column means everywhere else in the schema.
   */
  async recordUse(tx: DbTransaction, templateId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE ${ticketTemplates} SET usage_count = usage_count + 1
          WHERE ${ticketTemplates.id} = ${templateId}`,
    );
  }

  /** Whether another template of this brand already carries that name. */
  async nameTaken(
    tx: DbTransaction,
    name: string,
    { exceptId }: { readonly exceptId?: string } = {},
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: ticketTemplates.id })
      .from(ticketTemplates)
      .where(sql`lower(${ticketTemplates.name}) = lower(${name})`);

    return rows.some((row) => row.id !== exceptId);
  }

  /** What the placeholders are filled from: the brand, and a contact if one is named. */
  async subject(
    tx: DbTransaction,
    brandId: string,
    contactId: string | undefined,
  ): Promise<TemplateSubjectRow> {
    const brandRows = await tx
      .select({ name: brands.name })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);

    /* c8 ignore next -- the permission guard resolved this brand from a role in it. */
    const brandName = brandRows[0]?.name ?? '';

    if (contactId === undefined) {
      return { brandName, contact: undefined };
    }

    const rows = await tx
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    const contact = rows[0];
    if (contact === undefined) {
      // A contact of another brand is invisible to this transaction. The
      // preview then reads as it does with no contact at all, which is the
      // same answer "there is no such contact" deserves.
      return { brandName, contact: undefined };
    }

    // The addresses are rows of their own, so the earliest one is "the" address
    // — the same choice the contact screen's header makes. A separate query
    // rather than a join, because a join would multiply the contact row by the
    // number of addresses and then need a `DISTINCT ON` to undo it.
    const addresses = await tx
      .select({ value: contactIdentities.value })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.contactId, contactId), eq(contactIdentities.kind, 'email')))
      .orderBy(asc(contactIdentities.createdAt))
      .limit(1);

    return { brandName, contact: { name: contact.name, email: addresses[0]?.value ?? null } };
  }
}
