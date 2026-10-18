import { type DbTransaction, ticketActivity } from '@helpdock/db';
import {
  csatOriginalAnswerSchema,
  type ImportCsat,
  type ImportSource,
  ticketCsatSchema,
} from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ImportLoadError } from './contracts.js';

/** The answer ID also identifies its inert timeline row; replay never invents another event. */
export async function loadImportedCsatHistory(
  tx: DbTransaction,
  input: {
    brandId: string;
    departmentId: string;
    ticketId: string;
    id: string;
    source: ImportSource;
    answer: ImportCsat;
    unchanged?: boolean;
  },
): Promise<void> {
  const [existing] = await tx
    .select({
      ticketId: ticketActivity.ticketId,
      action: ticketActivity.action,
      to: ticketActivity.to,
    })
    .from(ticketActivity)
    .where(and(eq(ticketActivity.id, input.id), eq(ticketActivity.brandId, input.brandId)))
    .for('update');
  if (
    existing &&
    (existing.ticketId !== input.ticketId || existing.action !== 'ticket.imported.event')
  )
    throw new ImportLoadError('target-unavailable');
  if (existing) {
    const origin = z
      .object({
        action: z.literal('csat.response'),
        source: z.literal(input.source),
        externalId: z.literal(input.answer.externalId),
      })
      .safeParse(existing.to?.sourceEvent);
    if (!origin.success) throw new ImportLoadError('target-unavailable');
  }
  if (input.unchanged) {
    if (!existing) throw new ImportLoadError('target-unavailable');
    return;
  }
  const { answer } = input;
  const originalAnswers = csatOriginalAnswerSchema
    .array()
    .max(1000)
    .safeParse(answer.sourceDetails?.originalAnswers);
  const csat = ticketCsatSchema.parse({
    state: answer.rating === null ? 'imported_unscored' : 'rated',
    rating: answer.rating,
    comment: answer.comment ?? null,
    link: null,
    expiresAt: new Date(0).toISOString(),
    ratedAt: new Date(answer.ratedAt).toISOString(),
    ...(originalAnswers.success ? { originalAnswers: originalAnswers.data } : {}),
  });
  const values = {
    actorType: 'system' as const,
    actorId: `import:${input.source}:system`,
    action: 'ticket.imported.event',
    via: 'system' as const,
    to: {
      changes: {},
      csat,
      sourceEvent: {
        source: input.source,
        externalId: answer.externalId,
        action: 'csat.response',
        authorDisplay: null,
        authorId: null,
        authorType: 'system',
        details: answer.sourceDetails ?? {},
      },
    },
    createdAt: new Date(answer.ratedAt),
  };
  if (existing) await tx.update(ticketActivity).set(values).where(eq(ticketActivity.id, input.id));
  else
    await tx.insert(ticketActivity).values({
      id: input.id,
      brandId: input.brandId,
      ticketId: input.ticketId,
      departmentId: input.departmentId,
      ...values,
    });
}
