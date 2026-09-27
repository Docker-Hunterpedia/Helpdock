import type { CannedResponse, DbTransaction } from '@helpdock/db';
import {
  MAX_MACROS_PER_BRAND,
  type Macro,
  type MacroAction,
  type MacroBodies,
  type MacroCreateRequest,
  type MacroList,
  type MacroListQuery,
  type MacroUpdateRequest,
  macroActionSchema,
  macroShapeProblem,
} from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from '../ticketing/audit.js';
import { referencesOf } from './macro-actions.js';
import {
  editsMacro,
  type MacroActor,
  type MacroOwnership,
  seesMacro,
  usableIn,
} from './macro-rules.js';
import { type MacrosRepository, readRenderTicket } from './macros.repository.js';

/**
 * Macros and canned responses as configuration (M3-06): the list, and the
 * editor's create, update and delete. Applying one to a ticket is
 * `MacroRunService`; filling one in is `CannedResponsesService`.
 *
 * **Personal items are guarded by the database.** Another person's is not a
 * row this transaction can read, so every path below answers 404 for it — the
 * same answer as for an id that does not exist. Shared items are this
 * service's to guard, with `macro-rules.ts`.
 *
 * **Shared changes are audited**, with the before and after of what moved; a
 * personal item is its owner's habit and is not, as with views.
 */

export interface MacrosContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: MacroActor;
}

/** What the audit row keeps of a body: enough to recognise it, not the whole letter. */
const AUDIT_BODY_CHARS = 280;

const storedActionsSchema = z.array(macroActionSchema);

export class MacrosService {
  readonly #repository: MacrosRepository;

  constructor(repository: MacrosRepository) {
    this.#repository = repository;
  }

  async list(context: MacrosContext, query: MacroListQuery): Promise<MacroList> {
    const rows = await this.#repository.list(context.tx, { kind: query.kind, q: query.q });
    const { departmentId } = query;

    return {
      macros: rows
        .filter((row) => seesMacro(context.actor, row))
        .filter((row) => departmentId === undefined || usableIn(row, departmentId))
        .map((row) => toMacro(row, context.actor)),
    };
  }

  /**
   * That the reader may use this item on this ticket: it is theirs, or shared
   * with the ticket's department or with every department. Otherwise 404, the
   * same answer as for an item that does not exist.
   */
  async assertUsable(context: MacrosContext, id: string, ticketId: string): Promise<void> {
    const ticket = await readRenderTicket(context.tx, ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }

    const row = await this.#require(context, id);
    if (!usableIn(row, ticket.departmentId)) {
      throw new NotFoundException('No such macro or canned response for this ticket');
    }
  }

  async create(context: MacrosContext, request: MacroCreateRequest): Promise<Macro> {
    const ownership = ownershipOf(context.actor, request.scope, request.departmentId);
    this.#assertMayEdit(context.actor, ownership);
    await this.#assertDepartment(context.tx, ownership.departmentId);
    await this.#assertReferences(context.tx, request.actions);

    if ((await this.#repository.count(context.tx)) >= MAX_MACROS_PER_BRAND) {
      throw new ConflictException(`A brand keeps at most ${MAX_MACROS_PER_BRAND} of these`);
    }

    const row = await this.#repository.create(context.tx, {
      brandId: context.brandId,
      ...ownership,
      kind: request.kind,
      name: request.name,
      bodies: request.bodies,
      actions: request.actions,
      updatedBy: context.actor.userId,
    });

    if (row.ownerId === null) {
      await this.#audit(context, 'macro.created', row, { after: auditShape(row) });
    }

    return toMacro(row, context.actor);
  }

  async update(context: MacrosContext, id: string, request: MacroUpdateRequest): Promise<Macro> {
    const row = await this.#require(context, id);
    this.#assertMayEdit(context.actor, row);

    const scope = request.scope ?? (row.ownerId === null ? 'shared' : 'personal');
    const ownership = ownershipOf(
      context.actor,
      scope,
      request.departmentId !== undefined
        ? request.departmentId
        : scope === 'personal'
          ? null
          : row.departmentId,
    );
    // Moving an item is changing it twice: out of where it was, into where it goes.
    this.#assertMayEdit(context.actor, ownership);

    const merged = {
      kind: row.kind,
      scope,
      departmentId: ownership.departmentId,
      bodies: request.bodies ?? bodiesOf(row),
      actions: request.actions ?? actionsOf(row),
    };
    const problem = macroShapeProblem(merged);
    if (problem !== null) {
      throw new BadRequestException(problem);
    }
    await this.#assertDepartment(context.tx, ownership.departmentId);
    await this.#assertReferences(context.tx, merged.actions);

    const updated = await this.#repository.update(context.tx, id, {
      ...ownership,
      ...(request.name === undefined ? {} : { name: request.name }),
      bodies: merged.bodies,
      actions: merged.actions,
      updatedBy: context.actor.userId,
    });
    /* c8 ignore next 3 -- the read above proved the row is visible and editable. */
    if (updated === undefined) {
      throw new NotFoundException('No such macro or canned response');
    }

    if (row.ownerId === null || updated.ownerId === null) {
      const [before, after] = changedFields(auditShape(row), auditShape(updated));
      await this.#audit(context, 'macro.updated', updated, { before, after });
    }

    return toMacro(updated, context.actor);
  }

  async remove(context: MacrosContext, id: string): Promise<void> {
    const row = await this.#require(context, id);
    this.#assertMayEdit(context.actor, row);

    await this.#repository.remove(context.tx, id);

    if (row.ownerId === null) {
      await this.#audit(context, 'macro.deleted', row, { before: auditShape(row) });
    }
  }

  // ------------------------------------------------------------------

  async #require(context: MacrosContext, id: string): Promise<CannedResponse> {
    const row = await this.#repository.find(context.tx, id);
    // A shared item of a department the reader does not reach is "not found",
    // as somebody else's personal one is.
    if (row === undefined || !seesMacro(context.actor, row)) {
      throw new NotFoundException('No such macro or canned response');
    }

    return row;
  }

  #assertMayEdit(actor: MacroActor, item: MacroOwnership): void {
    if (!editsMacro(actor, item)) {
      throw new TicketingFailure('out-of-scope');
    }
  }

  async #assertDepartment(tx: DbTransaction, departmentId: string | null): Promise<void> {
    if (departmentId !== null && !(await this.#repository.departmentExists(tx, departmentId))) {
      throw new NotFoundException('No such department in this brand');
    }
  }

  async #assertReferences(tx: DbTransaction, actions: readonly MacroAction[]): Promise<void> {
    if (!(await this.#repository.referencesExist(tx, referencesOf(actions)))) {
      // A status, tag, team or person of another brand is invisible to this
      // transaction, so "no such" answers both "there is none" and "not yours".
      throw new NotFoundException(
        'An action names a status, tag, team or person this brand has not got',
      );
    }
  }

  async #audit(
    context: MacrosContext,
    action: 'macro.created' | 'macro.updated' | 'macro.deleted',
    row: CannedResponse,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action,
      targetType: 'macro',
      targetId: row.id,
      meta: { name: row.name, kind: row.kind, ...meta },
    });
  }
}

// --------------------------------------------------------------------------

const ownershipOf = (
  actor: MacroActor,
  scope: 'shared' | 'personal',
  departmentId: string | null,
): MacroOwnership =>
  scope === 'personal'
    ? { ownerId: actor.userId, departmentId: null }
    : { ownerId: null, departmentId };

/** The stored bodies, with both keys whatever an older row held. */
export const bodiesOf = (row: Pick<CannedResponse, 'bodies'>): MacroBodies => ({
  en: row.bodies.en ?? '',
  ar: row.bodies.ar ?? '',
});

/** The stored actions, validated on the way out as on the way in. */
export const actionsOf = (row: Pick<CannedResponse, 'actions'>): MacroAction[] =>
  storedActionsSchema.parse(row.actions);

export const toMacro = (row: CannedResponse, actor: MacroActor): Macro => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  scope: row.ownerId === null ? 'shared' : 'personal',
  departmentId: row.departmentId,
  bodies: bodiesOf(row),
  actions: actionsOf(row),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
  updatedById: row.updatedBy,
  canEdit: editsMacro(actor, row),
});

const truncate = (text: string): string =>
  text.length > AUDIT_BODY_CHARS ? `${text.slice(0, AUDIT_BODY_CHARS)}…` : text;

/** What an audit row records of an item: its shape, and the start of each body. */
const auditShape = (row: CannedResponse): Record<string, unknown> => {
  const bodies = bodiesOf(row);

  return {
    name: row.name,
    scope: row.ownerId === null ? 'shared' : 'personal',
    departmentId: row.departmentId,
    'bodies.en': truncate(bodies.en),
    'bodies.ar': truncate(bodies.ar),
    actions: actionsOf(row),
  };
};

/** Only the fields that moved, on each side, so the viewer's diff is the change. */
const changedFields = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] => {
  const keys = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );

  return [
    Object.fromEntries(keys.map((key) => [key, before[key]])),
    Object.fromEntries(keys.map((key) => [key, after[key]])),
  ];
};
