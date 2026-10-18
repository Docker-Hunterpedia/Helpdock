import { type DbTransaction, tags, ticketTags } from '@helpdock/db';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { ImportLoadError, type TicketLoad } from './contracts.js';

/** Mappings explicitly skip a source label or name a tag of this brand. */
export async function loadImportedTags(
  tx: DbTransaction,
  input: TicketLoad,
  ticketId: string,
): Promise<void> {
  const selected = [
    ...new Set(
      input.resolved.tags
        .filter((mapping) => input.record.tags.includes(mapping.externalValue))
        .flatMap((mapping) => (mapping.tagId ? [mapping.tagId] : [])),
    ),
  ];
  if (selected.length) {
    const visible = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.brandId, input.brandId), inArray(tags.id, selected)));
    if (visible.length !== selected.length) throw new ImportLoadError('mapping-invalid');
  }
  await tx
    .delete(ticketTags)
    .where(
      and(
        eq(ticketTags.ticketId, ticketId),
        selected.length ? notInArray(ticketTags.tagId, selected) : undefined,
      ),
    );
  if (selected.length)
    await tx
      .insert(ticketTags)
      .values(
        selected.map((tagId) => ({
          ticketId,
          tagId,
          brandId: input.brandId,
          departmentId: input.resolved.departmentId,
        })),
      )
      .onConflictDoNothing();
}
