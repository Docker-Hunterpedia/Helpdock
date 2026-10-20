import {
  type DbTransaction,
  type Ticket as TicketRow,
  uuidv7,
  withWidenedDepartments,
} from '@helpdock/db';
import {
  BULK_OPERATIONS_PER_MINUTE,
  BULK_PREVIEWS_PER_MINUTE,
  BULK_UNDO_WINDOW_SECONDS,
  type BulkChanges,
  type BulkField,
  type BulkRequest,
  type BulkResponse,
  type BulkTicketResult,
  type BulkUndoResponse,
  type BulkUndoTicketResult,
  bulkChangesSchema,
  type Ticket,
  type TicketUpdateRequest,
} from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Principal } from '../../auth/principal.js';
import type { RateLimiter, RateLimitRule } from '../../auth/rate-limit.js';
import { TicketingFailure } from '../../brands/ticketing-failure.js';
import { getTx } from '../../context/request-context.js';
import { tagsOfTicket } from '../../ticketing/ticket-tags.js';
import type { TicketTagsService } from '../../ticketing/ticket-tags.service.js';
import { TicketLifecycleFailure } from '../lifecycle/lifecycle-failure.js';
import type { TicketSpamService } from '../ticket-spam.service.js';
import type { TicketRepository } from '../tickets.repository.js';
import type { TicketsService } from '../tickets.service.js';
import type { BulkRepository } from './bulk.repository.js';
import { enqueueBulkUndone } from './bulk-events.js';
import {
  fieldsOf,
  type ItemValues,
  itemDiff,
  normaliseInstant,
  planUndo,
  sortedTagIds,
  type TicketSnapshot,
  tagsAfter,
  updateFor,
} from './bulk-plan.js';

/**
 * M14-03: the bulk edit and its Undo (DOMAIN-RULES §2.7, ADR 0036).
 *
 * There is no second write path. Each ticket goes through the methods a single
 * edit uses — {@link TicketsService.update} for columns, status, snooze and
 * custom fields, the spam service for Mark spam, the tags service for tags — so
 * authorization, department scope, transitions, activity, outbox events, wakes,
 * SLA effects and rules are the single edit's, one ticket at a time. The only
 * things added here are the batch's: a fixed lock order, a savepoint per ticket
 * so one refusal does not poison the transaction, and the operation log.
 *
 * **Preview** runs the very same work and rolls each ticket back, so what it
 * reports is what the apply would do rather than a re-implementation of the
 * checks. **Apply** keeps it, if and only if the tickets that change are
 * exactly the ones the preview named.
 */

/** Applies and undos share one budget per person; a preview has its own, looser one. */
export const BULK_APPLY_RULE: RateLimitRule = {
  bucket: 'ticket-bulk-apply',
  limit: BULK_OPERATIONS_PER_MINUTE,
  windowSeconds: 60,
};
export const BULK_PREVIEW_RULE: RateLimitRule = {
  bucket: 'ticket-bulk-preview',
  limit: BULK_PREVIEWS_PER_MINUTE,
  windowSeconds: 60,
};

/** One ticket's work, before it is told apart into a preview or an apply. */
type Processed =
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'refused'; readonly code: string }
  | {
      readonly outcome: 'will_change';
      readonly fields: BulkField[];
      readonly before: ItemValues;
      readonly after: ItemValues;
      readonly departmentId: string;
    };

interface Run {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly principal: Principal & { readonly type: 'staff' };
  readonly changes: BulkChanges;
  readonly closedStatusId: string | undefined;
  readonly operationId: string;
  /** Apply keeps a ticket's writes; a preview rolls them back. */
  readonly keep: boolean;
}

export class BulkService {
  readonly #tickets: TicketsService;
  readonly #ticketReads: TicketRepository;
  readonly #spam: TicketSpamService;
  readonly #tags: TicketTagsService;
  readonly #bulk: BulkRepository;
  readonly #limiter: Pick<RateLimiter, 'consume'>;
  readonly #now: () => Date;

  constructor(deps: {
    readonly tickets: TicketsService;
    readonly ticketReads: TicketRepository;
    readonly spam: TicketSpamService;
    readonly tags: TicketTagsService;
    readonly bulk: BulkRepository;
    readonly limiter: Pick<RateLimiter, 'consume'>;
    readonly now?: () => Date;
  }) {
    this.#tickets = deps.tickets;
    this.#ticketReads = deps.ticketReads;
    this.#spam = deps.spam;
    this.#tags = deps.tags;
    this.#bulk = deps.bulk;
    this.#limiter = deps.limiter;
    this.#now = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ preview, apply

  async run(brandId: string, principal: Principal, request: BulkRequest): Promise<BulkResponse> {
    const actor = this.#staff(principal);
    await this.#throttle(
      request.mode === 'apply' ? BULK_APPLY_RULE : BULK_PREVIEW_RULE,
      brandId,
      actor.id,
    );

    const tx = getTx();
    const operationId = uuidv7();
    const apply = request.mode === 'apply';
    const closedStatusId =
      request.changes.close === undefined ? undefined : await this.#bulk.closedStatusId(tx);
    if (request.changes.close !== undefined && closedStatusId === undefined) {
      throw new ConflictException('This brand has no Closed status');
    }

    // The locks come first and in one order, so a batch never waits on a ticket
    // it could have taken before the one it holds (ADR 0036).
    const visible = new Set(await this.#bulk.lockTickets(tx, request.ticketIds));
    const run: Run = {
      tx,
      brandId,
      principal: actor,
      changes: request.changes,
      closedStatusId,
      operationId,
      keep: apply,
    };

    const processed = new Map<string, Processed>();
    for (const ticketId of [...request.ticketIds].sort()) {
      processed.set(
        ticketId,
        visible.has(ticketId) ? await this.#process(run, ticketId) : { outcome: 'not_found' },
      );
    }

    const results = request.ticketIds.map((ticketId) =>
      resultOf(ticketId, processed.get(ticketId)),
    );
    const counts = countsOf(results);

    if (!apply) {
      return { mode: 'preview', results, counts, operationId: null, undoUntil: null };
    }

    const changed = results.filter((result) => result.outcome === 'will_change');
    const expected = new Set(request.expect);
    if (
      changed.length !== expected.size ||
      changed.some((result) => !expected.has(result.ticketId))
    ) {
      // Thrown, so the request's transaction rolls back every ticket written above.
      throw new TicketLifecycleFailure('bulk-changed');
    }
    if (changed.length === 0) {
      return { mode: 'apply', results, counts, operationId: null, undoUntil: null };
    }

    const undoUntil = new Date(this.#now().getTime() + BULK_UNDO_WINDOW_SECONDS * 1_000);
    await this.#bulk.insertOperation(tx, {
      id: operationId,
      brandId,
      actorId: actor.id,
      changes: request.changes,
      ticketCount: changed.length,
      undoUntil,
    });
    for (const [ticketId, work] of processed) {
      if (work.outcome === 'will_change') {
        await this.#recordItem(tx, brandId, operationId, ticketId, work);
      }
    }

    return {
      mode: 'apply',
      results,
      counts,
      operationId,
      undoUntil: undoUntil.toISOString(),
    };
  }

  /**
   * One ticket, in a savepoint. A refusal is the single edit's refusal, with its
   * code; anything else (a lost connection, a bug) is not a ticket's answer and
   * propagates, taking the batch with it.
   */
  async #process(run: Run, ticketId: string): Promise<Processed> {
    const { tx } = run;
    const found = await this.#ticketReads.findTicket(tx, ticketId);
    if (found === undefined) {
      return { outcome: 'not_found' };
    }

    try {
      return await this.#bulk.withSavepoint(tx, async () => {
        const work = await this.#change(run, found.ticket, found.status.id);
        return { value: work, keep: run.keep && work.outcome === 'will_change' };
      });
    } catch (error) {
      const code = refusalCode(error);
      if (code === null) {
        throw error;
      }

      return { outcome: 'refused', code };
    }
  }

  async #change(run: Run, before: TicketRow, statusId: string): Promise<Processed> {
    const { tx, brandId, principal, changes } = run;
    const via = { via: 'bulk', bulkOperationId: run.operationId } as const;
    const tagsBefore = sortedTagIds((await tagsOfTicket(tx, before.id)).map((tag) => tag.id));
    const customKey = changes.customField?.key;
    const start = snapshotOfRow(before, statusId, tagsBefore, customKey);

    let tagIds = tagsBefore;
    let view: Ticket | undefined;

    // Tags and spam first and the update last: the update may move the ticket
    // into a department the actor cannot see (an escalation), after which
    // nothing else of theirs can reach it.
    const wanted = tagsAfter(changes, tagsBefore);
    if (wanted !== undefined) {
      const written = await this.#tags.replace(
        tx,
        brandId,
        principal,
        before.id,
        { tagIds: wanted },
        'bulk',
      );
      tagIds = sortedTagIds(written.tags.map((tag) => tag.id));
    }
    if (changes.spam !== undefined) {
      view = await this.#spam.mark(brandId, principal, before.id, null, 'bulk');
    }
    const update = updateFor(changes, {
      actorId: principal.id,
      closedStatusId: run.closedStatusId,
    });
    if (update !== undefined) {
      view = await this.#tickets.update(
        brandId,
        principal,
        before.id,
        update as TicketUpdateRequest,
        via,
      );
    }

    const end =
      view === undefined
        ? await this.#reread(tx, before.id, tagIds, customKey)
        : snapshotOfView(view, tagIds, customKey);
    const diff = itemDiff(start, end, changes);
    const fields = fieldsOf(diff.after, changes);
    if (fields.length === 0) {
      return { outcome: 'unchanged' };
    }

    return {
      outcome: 'will_change',
      fields,
      before: diff.before,
      after: diff.after,
      departmentId: end.departmentId,
    };
  }

  async #reread(
    tx: DbTransaction,
    ticketId: string,
    tagIds: string[],
    customKey: string | undefined,
  ): Promise<TicketSnapshot> {
    const found = await this.#ticketReads.findTicket(tx, ticketId);
    /* c8 ignore next 3 -- the ticket was read and locked a moment ago, in this transaction. */
    if (found === undefined) {
      throw new NotFoundException('No such ticket');
    }

    return snapshotOfRow(found.ticket, found.status.id, tagIds, customKey);
  }

  /**
   * The item goes in under the ticket's new department, which an escalation
   * makes one the actor cannot see; the insert is then made inside the same
   * widened window the move was, so the department trigger can find the parent.
   */
  async #recordItem(
    tx: DbTransaction,
    brandId: string,
    operationId: string,
    ticketId: string,
    work: Extract<Processed, { outcome: 'will_change' }>,
  ): Promise<void> {
    const insert = (): Promise<void> =>
      this.#bulk.insertItems(tx, [
        {
          brandId,
          operationId,
          ticketId,
          departmentId: work.departmentId,
          before: work.before,
          after: work.after,
        },
      ]);

    if (await this.#ticketReads.departmentIsWritable(tx, work.departmentId)) {
      await insert();
      return;
    }

    await withWidenedDepartments(tx, [work.departmentId], insert);
  }

  // --------------------------------------------------------------------- undo

  async undo(
    brandId: string,
    principal: Principal,
    operationId: string,
  ): Promise<BulkUndoResponse> {
    const actor = this.#staff(principal);
    await this.#throttle(BULK_APPLY_RULE, brandId, actor.id);

    const tx = getTx();
    const operation = await this.#bulk.lockOperation(tx, operationId);
    // Another person's operation, another brand's and a purged one are all this.
    if (operation === undefined) {
      throw new NotFoundException('No such bulk operation');
    }
    if (operation.undoneAt !== null) {
      throw new TicketLifecycleFailure('bulk-already-undone');
    }
    const now = this.#now();
    if (now.getTime() > operation.undoUntil.getTime()) {
      throw new TicketLifecycleFailure('bulk-undo-expired');
    }

    // Written by this service, but read back across a boundary: parsed, not trusted.
    const changes = bulkChangesSchema.parse(operation.changes);
    const items = await this.#bulk.itemsOf(tx, operationId);
    await this.#bulk.lockTickets(
      tx,
      items.map((item) => item.ticketId),
    );

    const results: BulkUndoTicketResult[] = [];
    for (const item of items) {
      results.push(await this.#undoItem(tx, brandId, actor, changes, item));
    }

    await this.#bulk.markUndone(tx, operationId, now);
    await enqueueBulkUndone(tx, brandId, { operationId });

    return { operationId, results, notFound: Math.max(0, operation.ticketCount - items.length) };
  }

  async #undoItem(
    tx: DbTransaction,
    brandId: string,
    principal: Principal & { readonly type: 'staff' },
    changes: BulkChanges,
    item: {
      readonly ticketId: string;
      readonly before: Record<string, unknown>;
      readonly after: Record<string, unknown>;
    },
  ): Promise<BulkUndoTicketResult> {
    const found = await this.#ticketReads.findTicket(tx, item.ticketId);
    if (found === undefined) {
      return { ticketId: item.ticketId, outcome: 'not_found', reverted: [], kept: [], code: null };
    }

    const customKey = changes.customField?.key;
    const tagIds = sortedTagIds((await tagsOfTicket(tx, item.ticketId)).map((tag) => tag.id));
    const current = snapshotOfRow(found.ticket, found.status.id, tagIds, customKey);
    const plan = planUndo(
      { before: item.before as ItemValues, after: item.after as ItemValues },
      current,
      changes,
      customKey,
    );

    const reverted: BulkField[] = [...plan.reverted];
    const kept: BulkField[] = [...plan.kept];
    let code: string | null = null;
    // A step the rules refuse leaves its fields as they are, and says why.
    const attempt = async (
      fields: readonly BulkField[],
      step: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await this.#bulk.withSavepoint(tx, async () => ({ value: await step(), keep: true }));
      } catch (error) {
        code = refusalCode(error);
        if (code === null) {
          throw error;
        }
        for (const field of fields) {
          reverted.splice(reverted.indexOf(field), 1);
          kept.push(field);
        }
      }
    };

    if (plan.tagIds !== undefined) {
      const wanted = plan.tagIds;
      await attempt(['tags'], () =>
        this.#tags.replace(tx, brandId, principal, item.ticketId, { tagIds: wanted }, 'bulk_undo'),
      );
    }
    if (plan.update !== undefined) {
      const update = plan.update as TicketUpdateRequest;
      const fields = plan.reverted.filter((field) => field !== 'tags');
      await attempt(fields, () =>
        this.#tickets.update(brandId, principal, item.ticketId, update, { via: 'bulk_undo' }),
      );
    }

    return {
      ticketId: item.ticketId,
      outcome: reverted.length === 0 ? 'kept' : kept.length === 0 ? 'reverted' : 'partly_reverted',
      reverted,
      kept,
      code,
    };
  }

  // ------------------------------------------------------------------ helpers

  #staff(principal: Principal): Principal & { readonly type: 'staff' } {
    if (principal.type !== 'staff') {
      // Staff only (ADR 0036): an API client loops with idempotency keys.
      throw new ForbiddenException('Bulk edits are made by a signed-in member of staff');
    }

    return principal;
  }

  async #throttle(rule: RateLimitRule, brandId: string, userId: string): Promise<void> {
    if (!(await this.#limiter.consume(rule, `${brandId}:${userId}`))) {
      throw new HttpException('Too many bulk edits; wait a moment', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

const snapshotOfRow = (
  row: TicketRow,
  statusId: string,
  tagIds: readonly string[],
  customKey: string | undefined,
): TicketSnapshot => ({
  statusId,
  priority: row.priority,
  assigneeId: row.assigneeId,
  teamId: row.teamId,
  departmentId: row.departmentId,
  snoozedUntil: normaliseInstant(row.snoozedUntil),
  tagIds,
  custom: customValue(row.custom, customKey),
});

const snapshotOfView = (
  view: Ticket,
  tagIds: readonly string[],
  customKey: string | undefined,
): TicketSnapshot => ({
  statusId: view.status.id,
  priority: view.priority,
  assigneeId: view.assigneeId,
  teamId: view.teamId,
  departmentId: view.departmentId,
  snoozedUntil: normaliseInstant(view.snoozedUntil),
  tagIds,
  custom: customValue(view.custom, customKey),
});

const customValue = (custom: Record<string, unknown>, key: string | undefined): unknown =>
  key === undefined ? null : (custom[key] ?? null);

const resultOf = (ticketId: string, work: Processed | undefined): BulkTicketResult => {
  switch (work?.outcome) {
    case 'will_change':
      return { ticketId, outcome: 'will_change', fields: work.fields, code: null };
    case 'unchanged':
      return { ticketId, outcome: 'unchanged', fields: [], code: null };
    case 'refused':
      return { ticketId, outcome: 'refused', fields: [], code: work.code };
    default:
      return { ticketId, outcome: 'not_found', fields: [], code: null };
  }
};

const countsOf = (results: readonly BulkTicketResult[]) => ({
  willChange: results.filter((result) => result.outcome === 'will_change').length,
  unchanged: results.filter((result) => result.outcome === 'unchanged').length,
  refused: results.filter((result) => result.outcome === 'refused').length,
  notFound: results.filter((result) => result.outcome === 'not_found').length,
});

/**
 * The code a single edit's refusal carries, or null for an error that is not a
 * refusal. A 404 from inside the update is a thing the change names (a status,
 * a team, a tag) that is not this brand's; the ticket itself was read first.
 */
export const refusalCode = (error: unknown): string | null => {
  if (error instanceof TicketLifecycleFailure || error instanceof TicketingFailure) {
    return error.reason;
  }
  if (error instanceof NotFoundException) return 'unknown-reference';
  if (error instanceof BadRequestException) return 'invalid';
  if (error instanceof ForbiddenException) return 'forbidden';
  if (error instanceof ConflictException) return 'conflict';

  return null;
};
