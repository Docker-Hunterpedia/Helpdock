import { auditLog, importFilePresets } from '@helpdock/db';
import { fileHeaderFingerprint } from '@helpdock/importers';
import {
  type ImportFilePresetCreate,
  type ImportFilePresetListQuery,
  importFilePresetCreateSchema,
  importFilePresetListQuerySchema,
  importFilePresetListSchema,
  importFilePresetViewSchema,
} from '@helpdock/schemas';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { TicketingContext } from '../ticketing/ticketing-context.js';

function presetView(row: typeof importFilePresets.$inferSelect) {
  return importFilePresetViewSchema.parse({
    id: row.id,
    name: row.name,
    entity: row.entity,
    headerFingerprint: row.headerFingerprint,
    mapping: row.mapping,
    createdAt: row.createdAt.toISOString(),
  });
}

export class ImportFilePresetsService {
  async list({ tx, brandId }: TicketingContext, raw: ImportFilePresetListQuery) {
    const query = importFilePresetListQuerySchema.parse(raw);
    const rows = await tx
      .select()
      .from(importFilePresets)
      .where(
        and(
          eq(importFilePresets.brandId, brandId),
          query.after ? gt(importFilePresets.id, query.after) : undefined,
          query.entity ? eq(importFilePresets.entity, query.entity) : undefined,
          query.headerFingerprint
            ? eq(importFilePresets.headerFingerprint, query.headerFingerprint)
            : undefined,
        ),
      )
      .orderBy(asc(importFilePresets.id))
      .limit(51);
    return importFilePresetListSchema.parse({
      presets: rows.slice(0, 50).map(presetView),
      nextCursor: rows.length > 50 ? rows[49]?.id : null,
    });
  }

  async create(context: TicketingContext, raw: ImportFilePresetCreate) {
    const input = importFilePresetCreateSchema.parse(raw);
    // Serialise the case-insensitive name check without catching a failed SQL transaction.
    await context.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`import-presets:${context.brandId}`}, 0))`,
    );
    const [existing] = await context.tx
      .select({ id: importFilePresets.id })
      .from(importFilePresets)
      .where(
        and(
          eq(importFilePresets.brandId, context.brandId),
          sql`lower(${importFilePresets.name}) = lower(${input.name})`,
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException('import.preset-name-exists');
    const [preset] = await context.tx
      .insert(importFilePresets)
      .values({
        brandId: context.brandId,
        name: input.name,
        entity: input.mapping.entity,
        headerFingerprint: fileHeaderFingerprint(input.headers),
        mapping: { ...input.mapping },
        createdBy: context.actor.userId,
      })
      .returning();
    if (!preset) throw new Error('import.preset-create-failed');
    await this.audit(context, 'import.preset-created', preset.id);
    return presetView(preset);
  }

  async delete(context: TicketingContext, presetId: string) {
    const removed = await context.tx
      .delete(importFilePresets)
      .where(
        and(eq(importFilePresets.brandId, context.brandId), eq(importFilePresets.id, presetId)),
      )
      .returning({ id: importFilePresets.id });
    if (!removed.length) throw new NotFoundException('import.preset-not-found');
    await this.audit(context, 'import.preset-deleted', presetId);
    return { deleted: true as const };
  }

  private async audit({ tx, brandId, actor }: TicketingContext, action: string, targetId: string) {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: 'import_file_preset',
      targetId,
      meta: {},
    });
  }
}
