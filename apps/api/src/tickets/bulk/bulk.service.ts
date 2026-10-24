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
import { labelsOfFields } from '../close-requirements.js';
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
  type UndoPlan,
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
  | {
      readonly outcome: 'refused';
      readonly code: string;
      readonly missing?: BulkTicketResult['missing'];
    }
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
  readonly principal: Staff;
  readonly changes: BulkChanges;
  readonly closedStatusId: string | undefined;
  readonly operationId: string;
  /** Apply keeps a ticket's writes; a preview rolls them back. */
  readonly keep: boolean;
}

type Staff = Principal & { readonly type: 'staff' };

interface UndoItem {
  readonly id: string;
  readonly ticketId: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/** What an Undo of one ticket has put back and left, as the steps run. */
class UndoOutcome {
  readonly reverted: BulkField[];
  readonly kept: BulkField[];
  code: string | null = null;

  constructor(plan: UndoPlan) {
    this.reverted = [...plan.reverted];
    this.kept = [...plan.kept];
  }

  refuse(fields: readonly BulkField[], code: string): void {
    this.code = code;
    for (const field of fields) {
      this.reverted.splice(this.reverted.indexOf(field), 1);
      this.kept.push(field);
    }
  }

  resultFor(ticketId: string): BulkUndoTicketResult {
    const outcome =
      this.reverted.length === 0 ? 'kept' : this.kept.length === 0 ? 'reverted' : 'partly_reverted';

    return { ticketId, outcome, reverted: this.reverted, kept: this.kept, code: this.code };
  }
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

    try {
      return await this.#execute(brandId, actor, request);
    } catch (error) {
      throw deadlockAsConflict(error);
    }
  }

  async #execute(brandId: string, actor: Staff, request: BulkRequest): Promise<BulkResponse> {
    const apply = request.mode === 'apply';
    const run = await this.#prepare(brandId, actor, request.changes, apply);
    const processed = await this.#processAll(run, request.ticketIds);
    const results = request.ticketIds.map((id) => resultOf(id, processed.get(id)));
    const counts = countsOf(results);

    if (!apply) {
      return { mode: 'preview', results, counts, operationId: null, undoUntil: null };
    }

    assertExpected(results, request.expect ?? []);
    const recorded = await this.#record(run, processed);

    return { mode: 'apply', results, counts, ...recorded };
  }

  async #prepare(
    brandId: string,
    principal: Staff,
    changes: BulkChanges,
    keep: boolean,
  ): Promise<Run> {
    const tx = getTx();
    const closedStatusId = changes.close === undefined ? undefined : await this.#closedStatus(tx);

    return { tx, brandId, principal, changes, closedStatusId, operationId: uuidv7(), keep };
  }

  async #closedStatus(tx: DbTransaction): Promise<string> {
    const id = await this.#bulk.closedStatusId(tx);
    if (id === undefined) {
      throw new ConflictException('This brand has no Closed status');
    }

    return id;
  }

  /**
   * The locks come first and in one order, so a batch never waits on a ticket
   * it could have taken before the one it holds (ADR 0036).
   */
  async #processAll(run: Run, ticketIds: readonly string[]): Promise<Map<string, Processed>> {
    const visible = new Set(await this.#bulk.lockTickets(run.tx, ticketIds));
    const processed = new Map<string, Processed>();
    for (const ticketId of [...ticketIds].sort()) {
      processed.set(
        ticketId,
        visible.has(ticketId) ? await this.#process(run, ticketId) : { outcome: 'not_found' },
      );
    }

    return processed;
  }

  /** Writes the operation and one item per changed ticket; nothing when nothing changed. */
  async #record(
    run: Run,
    processed: ReadonlyMap<string, Processed>,
  ): Promise<{ operationId: string | null; undoUntil: string | null }> {
    const changed = [...processed].filter(([, work]) => work.outcome === 'will_change');
    if (changed.length === 0) {
      return { operationId: null, undoUntil: null };
    }

    const { tx, brandId, operationId } = run;
    const undoUntil = new Date(this.#now().getTime() + BULK_UNDO_WINDOW_SECONDS * 1_000);
    await this.#bulk.insertOperation(tx, {
      id: operationId,
      brandId,
      actorId: run.principal.id,
      changes: run.changes,
      ticketCount: changed.length,
      undoUntil,
    });
    for (const [ticketId, work] of changed) {
      if (work.outcome === 'will_change') {
        await this.#recordItem(tx, brandId, operationId, ticketId, work);
      }
    }

    return { operationId, undoUntil: undoUntil.toISOString() };
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

      // The savepoint is rolled back, so the transaction can still be read.
      const missing =
        error instanceof TicketLifecycleFailure && error.reason === 'fields-required-to-close'
          ? await labelsOfFields(tx, error.fields)
          : undefined;

      return { outcome: 'refused', code, ...(missing === undefined ? {} : { missing }) };
    }
  }

  /**
   * Tags and spam first and the update last: the update may move the ticket
   * into a department the actor cannot see (an escalation), after which
   * nothing else of theirs can reach it.
   */
  async #change(run: Run, before: TicketRow, statusId: string): Promise<Processed> {
    const { tx, changes } = run;
    const customKey = changes.customField?.key;
    const tagsBefore = sortedTagIds((await tagsOfTicket(tx, before.id)).map((tag) => tag.id));
    const start = snapshotOfRow(before, statusId, tagsBefore, customKey);

    const tagIds = await this.#changeTags(run, before.id, tagsBefore);
    const view = await this.#changeTicket(run, before.id);
    const end =
      view === undefined
        ? await this.#reread(tx, before.id, tagIds, customKey)
        : snapshotOfView(view, tagIds, customKey);

    return workOf(itemDiff(start, end, changes), changes, end.departmentId);
  }

  async #changeTags(run: Run, ticketId: string, current: string[]): Promise<string[]> {
    const wanted = tagsAfter(run.changes, current);
    if (wanted === undefined) {
      return current;
    }

    const { tx, brandId, principal } = run;
    const written = await this.#tags.replace(
      tx,
      brandId,
      principal,
      ticketId,
      { tagIds: wanted },
      'bulk',
    );

    return sortedTagIds(written.tags.map((tag) => tag.id));
  }

  /** Spam, then the update; the last view of the ticket, or none when neither ran. */
  async #changeTicket(run: Run, ticketId: string): Promise<Ticket | undefined> {
    const { brandId, principal, changes } = run;
    let view: Ticket | undefined;
    if (changes.spam !== undefined) {
      view = await this.#spam.mark(brandId, principal, ticketId, null, 'bulk');
    }
    const update = updateFor(changes, {
      actorId: principal.id,
      closedStatusId: run.closedStatusId,
    });
    if (update !== undefined) {
      view = await this.#tickets.update(
        brandId,
        principal,
        ticketId,
        update as TicketUpdateRequest,
        {
          via: 'bulk',
          bulkOperationId: run.operationId,
        },
      );
    }

    return view;
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

    try {
      return await this.#undoOperation(brandId, actor, operationId);
    } catch (error) {
      throw deadlockAsConflict(error);
    }
  }

  async #undoOperation(
    brandId: string,
    actor: Staff,
    operationId: string,
  ): Promise<BulkUndoResponse> {
    const tx = getTx();
    const operation = await this.#openOperation(tx, operationId);
    // Written by this service, but read back across a boundary: parsed, not trusted.
    const changes = bulkChangesSchema.parse(operation.changes);
    const items = await this.#bulk.itemsOf(tx, operationId);
    await this.#bulk.lockTickets(
      tx,
      items.map((item) => item.ticketId),
    );

    const results: BulkUndoTicketResult[] = [];
    for (const item of items) {
      const result = await this.#undoItem(tx, brandId, actor, changes, item);
      await this.#bulk.markReverted(tx, item.id, result.reverted);
      results.push(result);
    }

    await this.#bulk.markUndone(tx, operationId, this.#now());
    // Only an assignment the Undo really put back is taken back from its recipient.
    const unassigned = results
      .filter((result) => result.reverted.includes('assigneeId'))
      .map((result) => result.ticketId);
    if (unassigned.length > 0) {
      await enqueueBulkUndone(tx, brandId, { operationId, ticketIds: unassigned });
    }

    return { operationId, results, notFound: Math.max(0, operation.ticketCount - items.length) };
  }

  /** The caller's operation, locked, if it can still be undone. */
  async #openOperation(tx: DbTransaction, operationId: string) {
    const operation = await this.#bulk.lockOperation(tx, operationId);
    // Another person's operation, another brand's and a purged one are all this.
    if (operation === undefined) {
      throw new NotFoundException('No such bulk operation');
    }
    if (operation.undoneAt !== null) {
      throw new TicketLifecycleFailure('bulk-already-undone');
    }
    if (this.#now().getTime() > operation.undoUntil.getTime()) {
      throw new TicketLifecycleFailure('bulk-undo-expired');
    }

    return operation;
  }

  async #undoItem(
    tx: DbTransaction,
    brandId: string,
    principal: Staff,
    changes: BulkChanges,
    item: UndoItem,
  ): Promise<BulkUndoTicketResult> {
    const found = await this.#ticketReads.findTicket(tx, item.ticketId);
    if (found === undefined) {
      return { ticketId: item.ticketId, outcome: 'not_found', reverted: [], kept: [], code: null };
    }

    const customKey = changes.customField?.key;
    const tagIds = sortedTagIds((await tagsOfTicket(tx, item.ticketId)).map((tag) => tag.id));
    const plan = planUndo(
      { before: item.before as ItemValues, after: item.after as ItemValues },
      snapshotOfRow(found.ticket, found.status.id, tagIds, customKey),
      changes,
      customKey,
    );

    const outcome = new UndoOutcome(plan);
    await this.#revertTags(tx, brandId, principal, item.ticketId, plan, outcome);
    await this.#revertColumns(tx, brandId, principal, item.ticketId, plan, outcome);

    return outcome.resultFor(item.ticketId);
  }

  async #revertTags(
    tx: DbTransaction,
    brandId: string,
    principal: Staff,
    ticketId: string,
    plan: UndoPlan,
    outcome: UndoOutcome,
  ): Promise<void> {
    const wanted = plan.tagIds;
    if (wanted !== undefined) {
      await this.#attempt(tx, outcome, ['tags'], () =>
        this.#tags.replace(tx, brandId, principal, ticketId, { tagIds: wanted }, 'bulk_undo'),
      );
    }
  }

  async #revertColumns(
    tx: DbTransaction,
    brandId: string,
    principal: Staff,
    ticketId: string,
    plan: UndoPlan,
    outcome: UndoOutcome,
  ): Promise<void> {
    if (plan.update === undefined) {
      return;
    }

    const update = plan.update as TicketUpdateRequest;
    const fields = plan.reverted.filter((field) => field !== 'tags');
    await this.#attempt(tx, outcome, fields, () =>
      this.#tickets.update(brandId, principal, ticketId, update, {
        via: 'bulk_undo',
        ...(plan.closedAt === undefined ? {} : { closedAt: plan.closedAt }),
      }),
    );
  }

  /** A step the rules refuse leaves its fields as they are, and says why. */
  async #attempt(
    tx: DbTransaction,
    outcome: UndoOutcome,
    fields: readonly BulkField[],
    step: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.#bulk.withSavepoint(tx, async () => ({ value: await step(), keep: true }));
    } catch (error) {
      const code = refusalCode(error);
      if (code === null) {
        throw error;
      }
      outcome.refuse(fields, code);
    }
  }

  // ------------------------------------------------------------------ helpers

  #staff(principal: Principal): Staff {
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
  closedAt: normaliseInstant(row.closedAt),
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
  closedAt: normaliseInstant(view.closedAt),
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

/** A deadlock the lock order should prevent but a foreign writer could still cause: a retry, not a 500. */
export const deadlockAsConflict = (error: unknown): unknown => {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null) ?? {};

  return code.code === '40P01' || code.cause?.code === '40P01'
    ? new TicketLifecycleFailure('bulk-changed')
    : error;
};

/** The tickets that change must be exactly the ones the preview named, or nothing is kept. */
const assertExpected = (results: readonly BulkTicketResult[], expect: readonly string[]): void => {
  const expected = new Set(expect);
  const changed = results.filter((result) => result.outcome === 'will_change');
  if (
    changed.length !== expected.size ||
    changed.some((result) => !expected.has(result.ticketId))
  ) {
    // Thrown, so the request's transaction rolls back every ticket written.
    throw new TicketLifecycleFailure('bulk-changed');
  }
};

const workOf = (
  diff: ReturnType<typeof itemDiff>,
  changes: BulkChanges,
  departmentId: string,
): Processed => {
  const fields = fieldsOf(diff.after, changes);

  return fields.length === 0
    ? { outcome: 'unchanged' }
    : { outcome: 'will_change', fields, before: diff.before, after: diff.after, departmentId };
};

const resultOf = (ticketId: string, work: Processed | undefined): BulkTicketResult => {
  switch (work?.outcome) {
    case 'will_change':
      return { ticketId, outcome: 'will_change', fields: work.fields, code: null };
    case 'unchanged':
      return { ticketId, outcome: 'unchanged', fields: [], code: null };
    case 'refused':
      return {
        ticketId,
        outcome: 'refused',
        fields: [],
        code: work.code,
        ...(work.missing === undefined ? {} : { missing: work.missing }),
      };
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
