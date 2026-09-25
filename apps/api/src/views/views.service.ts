import type { DbTransaction, View as ViewRow } from '@helpdock/db';
import {
  type TicketView,
  type TicketViewCountList,
  type TicketViewCreateRequest,
  type TicketViewFilters,
  type TicketViewList,
  type TicketViewReorderRequest,
  type TicketViewUpdateRequest,
  type TicketViewVisibility,
  ticketViewFiltersSchema,
  VIEW_COUNT_CAP,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from '../ticketing/audit.js';
import type { TicketReader } from '../tickets/tickets.repository.js';
import { editsSharedView, seesSharedView, type ViewActor } from './view-rules.js';
import type { ViewsRepository } from './views.repository.js';

/**
 * Views (M1-05): a person's saved filters, a brand's shared ones, and the
 * seeded defaults.
 *
 * **A view never widens access.** Its filters are the ticket list's own query,
 * and a count runs them through the list's own `WHERE` inside the reader's
 * transaction, so the department policy decides what is counted exactly as it
 * decides what is listed. Nothing here reads a ticket any other way.
 *
 * **Personal views are guarded by the database**, not here: another person's
 * is not a row this transaction can read, so every path below that looks one
 * up answers 404 for it, the same answer as for an id that does not exist.
 * Shared views are the service's to guard, with `view-rules.ts`.
 *
 * **A built-in view is a row with rules.** It may be renamed, reordered and
 * hidden for the brand; it may not be deleted, refiltered or reshared, because
 * REQUIREMENTS §4.1 promises every brand those five queues.
 */

export interface ViewsContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: ViewActor;
}

/** What a count needs from the ticket list: its own `WHERE`, once per view, under a cap. */
export interface TicketCounter {
  countTickets(
    tx: DbTransaction,
    reader: TicketReader,
    filters: readonly TicketViewFilters[],
    cap: number,
  ): Promise<number[]>;
}

export class ViewsService {
  readonly #repository: ViewsRepository;
  readonly #tickets: TicketCounter;

  constructor(repository: ViewsRepository, tickets: TicketCounter) {
    this.#repository = repository;
    this.#tickets = tickets;
  }

  /** Every view the reader's sidebar may hold, hidden ones included for the Views tab. */
  async list(context: ViewsContext): Promise<TicketViewList> {
    return { views: (await this.#visible(context)).map((row) => toView(row, context.actor)) };
  }

  /**
   * One count per view in the sidebar, every view in one statement: each is
   * an index scan that stops at the cap, and one round trip for all of them
   * is what keeps the sidebar as cheap as a page of the list.
   */
  async counts(context: ViewsContext): Promise<TicketViewCountList> {
    const shown = (await this.#visible(context)).filter((row) => !row.hidden);
    const matched = await this.#tickets.countTickets(
      context.tx,
      { brandId: context.brandId, viewerId: context.actor.userId },
      shown.map(filtersOf),
      VIEW_COUNT_CAP,
    );

    return {
      counts: shown.map((row, index) => {
        const count = matched[index] ?? 0;
        return {
          viewId: row.id,
          count: Math.min(count, VIEW_COUNT_CAP),
          capped: count > VIEW_COUNT_CAP,
        };
      }),
    };
  }

  async create(context: ViewsContext, request: TicketViewCreateRequest): Promise<TicketView> {
    const personal = request.visibility.kind === 'personal';
    if (request.visibility.kind !== 'personal') {
      await this.#assertMayShare(context, request.visibility);
    }

    const ownerId = personal ? context.actor.userId : null;
    const row = await this.#repository.create(context.tx, {
      brandId: context.brandId,
      ownerId,
      name: request.name,
      nameAr: request.nameAr ?? null,
      filters: request.filters,
      visibleDepartmentIds: audienceOf(request.visibility),
      sortOrder: await this.#repository.nextSortOrder(context.tx, ownerId),
    });

    if (!personal) {
      await this.#audit(context, 'view.created', row.id, {
        name: row.name,
        audience: row.visibleDepartmentIds,
      });
    }

    return toView(row, context.actor);
  }

  async update(
    context: ViewsContext,
    viewId: string,
    request: TicketViewUpdateRequest,
  ): Promise<TicketView> {
    const row = await this.#require(context, viewId);
    this.#assertEditable(context, row);

    if (
      row.builtIn !== null &&
      (request.filters !== undefined || request.visibility !== undefined)
    ) {
      throw new TicketingFailure('view-is-built-in');
    }
    if (row.ownerId !== null && request.hidden !== undefined) {
      // Hiding is for the brand's sidebars. A person's own view they delete.
      throw new BadRequestException('Only a shared view can be hidden');
    }
    if (request.visibility !== undefined && request.visibility.kind !== 'personal') {
      await this.#assertMayShare(context, request.visibility);
    }

    const becomesOwner =
      request.visibility === undefined
        ? row.ownerId
        : request.visibility.kind === 'personal'
          ? context.actor.userId
          : null;
    const moves = becomesOwner !== row.ownerId;

    await this.#repository.update(context.tx, viewId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.filters === undefined ? {} : { filters: request.filters }),
      ...(request.hidden === undefined ? {} : { hidden: request.hidden }),
      ...(request.visibility === undefined
        ? {}
        : { ownerId: becomesOwner, visibleDepartmentIds: audienceOf(request.visibility) }),
      // A view that changes hands goes to the end of the list it joins.
      ...(moves
        ? { sortOrder: await this.#repository.nextSortOrder(context.tx, becomesOwner) }
        : {}),
    });

    if (row.ownerId === null || becomesOwner === null) {
      await this.#audit(context, 'view.updated', viewId, {
        ...request,
        wasNamed: row.name,
        wasAudience: row.visibleDepartmentIds,
      });
    }

    return toView(await this.#require(context, viewId), context.actor);
  }

  async remove(context: ViewsContext, viewId: string): Promise<void> {
    const row = await this.#require(context, viewId);
    this.#assertEditable(context, row);
    if (row.builtIn !== null) {
      throw new TicketingFailure('view-is-built-in');
    }

    await this.#repository.delete(context.tx, viewId);

    if (row.ownerId === null) {
      await this.#audit(context, 'view.deleted', viewId, { name: row.name });
    }
  }

  /**
   * Some views in a new order: all shared, or all the reader's own. They take
   * the places they held between them, in the order given, and the list is
   * then renumbered densely — so a Team Leader reorders the views they manage
   * without naming, or moving, the ones they do not.
   */
  async reorder(context: ViewsContext, request: TicketViewReorderRequest): Promise<TicketViewList> {
    if (new Set(request.viewIds).size !== request.viewIds.length) {
      throw new BadRequestException('The order names a view twice');
    }

    const rows = await this.#repository.list(context.tx);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const named = request.viewIds.map((id) => byId.get(id));
    if (named.some((row) => row === undefined)) {
      throw new NotFoundException('No such view');
    }

    const moving = named as ViewRow[];
    const owner = moving[0]?.ownerId ?? null;
    if (moving.some((row) => row.ownerId !== owner)) {
      throw new BadRequestException('Shared views and personal views are ordered separately');
    }
    for (const row of moving) {
      this.#assertEditable(context, row);
    }

    const list = rows.filter((row) => row.ownerId === owner);
    const slots = list.flatMap((row, index) => (request.viewIds.includes(row.id) ? [index] : []));
    const next = [...list];
    for (const [position, slot] of slots.entries()) {
      next[slot] = moving[position] as ViewRow;
    }

    await this.#repository.setSortOrders(
      context.tx,
      next.flatMap((row, index) =>
        row.sortOrder === index ? [] : [{ id: row.id, sortOrder: index }],
      ),
    );

    if (owner === null) {
      await this.#audit(context, 'view.reordered', context.brandId, { order: request.viewIds });
    }

    return this.list(context);
  }

  // ------------------------------------------------------------------

  /**
   * The rows this reader's sidebar may hold: their own, and the shared ones
   * whose audience reaches them. A brand that predates M1-05 gets its defaults
   * on the first read, inside the same transaction.
   */
  async #visible(context: ViewsContext): Promise<ViewRow[]> {
    if (!(await this.#repository.hasBuiltIns(context.tx))) {
      await this.#repository.seedBuiltIns(context.tx, context.brandId);
    }

    const rows = await this.#repository.list(context.tx);

    return rows.filter(
      (row) => row.ownerId !== null || seesSharedView(context.actor, row.visibleDepartmentIds),
    );
  }

  async #require(context: ViewsContext, viewId: string): Promise<ViewRow> {
    const row = await this.#repository.find(context.tx, viewId);
    // Somebody else's personal view is invisible to this transaction, and a
    // shared view outside the reader's departments is not theirs to know of:
    // both are "not found", like an id that does not exist.
    if (
      row === undefined ||
      (row.ownerId === null && !seesSharedView(context.actor, row.visibleDepartmentIds))
    ) {
      throw new NotFoundException('No such view');
    }

    return row;
  }

  #assertEditable(context: ViewsContext, row: ViewRow): void {
    if (!editable(row, context.actor)) {
      throw new TicketingFailure('out-of-scope');
    }
  }

  async #assertMayShare(
    context: ViewsContext,
    visibility: Exclude<TicketViewVisibility, { kind: 'personal' }>,
  ): Promise<void> {
    const audience = audienceOf(visibility);
    if (!editsSharedView(context.actor, audience)) {
      throw new TicketingFailure('out-of-scope');
    }

    if (audience !== null) {
      const known = await this.#repository.existingDepartments(context.tx, audience);
      if (audience.some((departmentId) => !known.has(departmentId))) {
        throw new NotFoundException('No such department');
      }
    }
  }

  async #audit(
    context: ViewsContext,
    action: 'view.created' | 'view.updated' | 'view.deleted' | 'view.reordered',
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action,
      targetType: action === 'view.reordered' ? 'brand' : 'view',
      targetId,
      meta,
    });
  }
}

const audienceOf = (visibility: TicketViewVisibility): string[] | null =>
  visibility.kind === 'departments' ? [...new Set(visibility.departmentIds)] : null;

const editable = (row: ViewRow, actor: ViewActor): boolean =>
  row.ownerId === null
    ? editsSharedView(actor, row.visibleDepartmentIds)
    : row.ownerId === actor.userId;

/**
 * The stored filters, parsed on the way out as they were on the way in. A row
 * the schema no longer accepts would be a list query the list refuses, so it
 * fails here, loudly, rather than as a count of nothing.
 */
const filtersOf = (row: ViewRow): TicketViewFilters => ticketViewFiltersSchema.parse(row.filters);

const visibilityOf = (row: ViewRow): TicketViewVisibility => {
  if (row.ownerId !== null) {
    return { kind: 'personal' };
  }

  return row.visibleDepartmentIds === null
    ? { kind: 'brand' }
    : { kind: 'departments', departmentIds: row.visibleDepartmentIds };
};

export const toView = (row: ViewRow, actor: ViewActor): TicketView => ({
  id: row.id,
  name: row.name,
  nameAr: row.nameAr,
  visibility: visibilityOf(row),
  builtIn: row.builtIn,
  departmentId: row.departmentId,
  filters: filtersOf(row),
  hidden: row.hidden,
  sortOrder: row.sortOrder,
  editable: editable(row, actor),
});
