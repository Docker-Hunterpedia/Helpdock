import { brands, type DbTransaction, type Ticket as TicketRow, tickets } from '@helpdock/db';
import { createI18n } from '@helpdock/i18n';
import type { AiPauseReason, TicketAiState } from '@helpdock/schemas';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { TicketRepository } from '../../tickets/tickets.repository.js';
import { aiMeta, type StoredAiMeta } from './ai-meta.js';

/**
 * Handoff persistence (M7-06, DOMAIN-RULES §9): `tickets.ai_paused_at` is
 * set when the model hands off, the customer asks for a person, or a staff
 * member replies or takes the ticket, and every auto-reply job reads it
 * immediately before it sends. Only "Return to assistant" clears it; a closed
 * conversation that continues does so on a new ticket, which starts unpaused.
 *
 * Both writes are conditional updates, so two pauses racing record one, and a
 * pause is announced in the staff thread only when it changed something and
 * the assistant had ever considered the conversation — a brand without
 * auto-reply does not get "Assistant paused" under every agent reply.
 */

export const isAiPaused = (
  ticket: Pick<TicketRow, 'aiPausedAt' | 'aiPausedUntil'>,
  now: Date,
): boolean =>
  ticket.aiPausedAt !== null &&
  (ticket.aiPausedUntil === null || ticket.aiPausedUntil.getTime() > now.getTime());

export const toTicketAiState = (
  ticket: Pick<TicketRow, 'aiPausedAt' | 'aiPausedUntil' | 'aiPauseReason'>,
): TicketAiState => ({
  pausedAt: ticket.aiPausedAt?.toISOString() ?? null,
  pausedUntil: ticket.aiPausedUntil?.toISOString() ?? null,
  reason: ticket.aiPausedAt === null ? null : (ticket.aiPauseReason as AiPauseReason | null),
});

export interface PauseInput {
  readonly brandId: string;
  readonly ticketId: string;
  readonly reason: AiPauseReason;
  readonly at: Date;
  /** Who caused it: a staff id, a visitor id, or the job. Written as the event's author. */
  readonly actorId: string;
  /** The handoff's confidence and threshold, for "confidence 0.42 below 0.70". */
  readonly confidence?: number;
  readonly threshold?: number;
}

const repository = new TicketRepository();

/** Pauses the assistant; answers the updated ticket, or undefined when it was already paused. */
export const pauseAi = async (
  tx: DbTransaction,
  input: PauseInput,
): Promise<TicketRow | undefined> => {
  const [paused] = await tx
    .update(tickets)
    .set({
      aiPausedAt: input.at,
      aiPausedUntil: null,
      aiPauseReason: input.reason,
      aiHandedOffAt: sql`coalesce(${tickets.aiHandedOffAt}, ${input.at.toISOString()}::timestamptz)`,
    })
    .where(and(eq(tickets.id, input.ticketId), isNull(tickets.aiPausedAt)))
    .returning();
  if (paused === undefined) {
    return undefined;
  }
  if (paused.aiEligibleAt !== null) {
    await writeEvent(tx, input.brandId, paused, input.actorId, {
      meta: aiMeta('paused', {
        reason: input.reason,
        confidence: input.confidence ?? null,
        threshold: input.threshold ?? null,
      }),
      key: `aiPaused.${input.reason}`,
      values: {
        confidence: (input.confidence ?? 0).toFixed(2),
        threshold: (input.threshold ?? 0).toFixed(2),
      },
    });
  }
  return paused;
};

/** "Return to assistant": answers the updated ticket, or undefined when it was not paused. */
export const resumeAi = async (
  tx: DbTransaction,
  input: { readonly brandId: string; readonly ticketId: string; readonly actorId: string },
): Promise<TicketRow | undefined> => {
  const [resumed] = await tx
    .update(tickets)
    .set({ aiPausedAt: null, aiPausedUntil: null, aiPauseReason: null })
    .where(and(eq(tickets.id, input.ticketId), isNotNull(tickets.aiPausedAt)))
    .returning();
  if (resumed === undefined) {
    return undefined;
  }
  await writeEvent(tx, input.brandId, resumed, input.actorId, {
    meta: aiMeta('resumed'),
    key: 'aiResumed',
    values: {},
  });
  return resumed;
};

/**
 * The System event in the staff thread. The admin draws it from `ai_meta` in
 * the reader's language; the body, in the brand's, is for every other reader
 * of the thread (the API, an export).
 */
const writeEvent = async (
  tx: DbTransaction,
  brandId: string,
  ticket: TicketRow,
  actorId: string,
  event: { meta: StoredAiMeta; key: string; values: Record<string, string> },
): Promise<void> => {
  const [brand] = await tx
    .select({ locale: brands.defaultLocale })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  const locale = brand?.locale ?? 'en';
  // The key is built from the reason at runtime, which the typed `t` cannot
  // check; every reason has its sentence in both catalogs (`ticket.json`).
  const t = createI18n({ lng: locale }).getFixedT(locale, 'ticket') as unknown as (
    key: string,
    values: Record<string, string>,
  ) => string;
  const text = t(`system.${event.key}`, event.values);

  await repository.insertMessage(tx, {
    brandId,
    ticketId: ticket.id,
    departmentId: ticket.departmentId,
    seq: await repository.nextSeq(tx, ticket.id),
    kind: 'system',
    authorType: 'system',
    authorId: actorId,
    // A fixed sentence and two figures: nothing here comes from a person.
    bodyHtml: `<p>${text}</p>`,
    bodyText: text,
    channel: ticket.channel,
    aiMeta: event.meta,
  });
};
