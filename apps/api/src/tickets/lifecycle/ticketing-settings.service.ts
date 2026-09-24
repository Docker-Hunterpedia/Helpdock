import type { DbTransaction, TicketStatus as TicketStatusRow } from '@helpdock/db';
import type {
  Brand,
  FeedbackSettingsUpdateRequest,
  ReplyBehaviourUpdateRequest,
  TicketingRefusal,
  TicketStatus,
  TicketStatusCreateRequest,
  TicketStatusList,
  TicketStatusReorderRequest,
  TicketStatusUpdateRequest,
  TicketStatusUsage,
} from '@helpdock/schemas';
import { MAX_TICKET_STATUSES_PER_BRAND, parseBrandSettings } from '@helpdock/schemas';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TicketingFailure } from '../../brands/ticketing-failure.js';
import type { ActivityActor } from '../ticket-activity.js';
import { writeTicketActivity } from '../ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../ticket-events.js';
import { toTicketStatus } from '../ticket-view.js';
import { TicketLifecycleRepository } from './lifecycle.repository.js';
import { statusDeleteRefusal, statusEditRefusal } from './status-rules.js';

/**
 * The Statuses tab of `Admin/Ticketing`, and the Reply behaviour card under it
 * (M1-08).
 *
 * Both are the brand's ticketing *shape* rather than the brand's own fields, so
 * both are `ticketing:manage` — held by an Admin and by a Team Leader, which is
 * what DOMAIN-RULES §2.3 asks for when it makes the reopen policy "editable by
 * Team Leaders and Admins" while `PATCH /api/brands/:brandId` stays Admin-only
 * because the same body carries the time zone.
 *
 * Everything here runs in the request's own transaction, so a refusal rolls
 * back what it was about and the audit row commits with the change it
 * describes. Nothing filters by brand: the policies do (DOMAIN-RULES §1.3).
 */

export interface TicketingSettingsContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: ActivityActor;
  readonly now: Date;
}

@Injectable()
export class TicketingSettingsService {
  readonly #lifecycle: TicketLifecycleRepository;

  constructor(@Inject(TicketLifecycleRepository) lifecycle: TicketLifecycleRepository) {
    this.#lifecycle = lifecycle;
  }

  // ----------------------------------------------------------------- statuses

  async list(tx: DbTransaction): Promise<TicketStatusList> {
    const rows = await this.#lifecycle.listStatuses(tx);

    return { statuses: rows.map(toTicketStatus) };
  }

  async create(
    context: TicketingSettingsContext,
    request: TicketStatusCreateRequest,
  ): Promise<TicketStatus> {
    await this.#assertNameFree(context.tx, request.name);

    if ((await this.#lifecycle.countStatuses(context.tx)) >= MAX_TICKET_STATUSES_PER_BRAND) {
      // Not a rule from DOMAIN-RULES but from the picker: a status list longer
      // than this is not a list anybody chooses from, and the reorder request
      // is bounded by the same number.
      throw new ConflictException('This brand already has the most statuses it can hold');
    }

    const created = await this.#lifecycle.insertStatus(context.tx, {
      brandId: context.brandId,
      name: request.name,
      nameAr: request.nameAr ?? null,
      systemState: request.systemState,
      pausesSla: request.pausesSla,
      awaitingCustomer: request.awaitingCustomer,
      color: request.color,
      sortOrder: await this.#lifecycle.nextStatusSortOrder(context.tx),
    });

    await this.#audit(context, 'ticket_status.created', created.id, { name: created.name });

    return toTicketStatus(created);
  }

  async update(
    context: TicketingSettingsContext,
    statusId: string,
    request: TicketStatusUpdateRequest,
  ): Promise<TicketStatus> {
    const status = await this.#require(context.tx, statusId);
    this.#refuse(statusEditRefusal(status, request));

    if (request.name !== undefined && request.name.toLowerCase() !== status.name.toLowerCase()) {
      await this.#assertNameFree(context.tx, request.name, statusId);
    }

    // One default per brand, and the move is two statements in one
    // transaction: clear it everywhere else, then set it here. Doing it the
    // other way round would leave a moment with two.
    if (request.isDefault === true && !status.isDefault) {
      await this.#lifecycle.clearDefaultStatus(context.tx, statusId);
    }

    const updated = await this.#lifecycle.updateStatus(context.tx, statusId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.systemState === undefined ? {} : { systemState: request.systemState }),
      ...(request.pausesSla === undefined ? {} : { pausesSla: request.pausesSla }),
      ...(request.awaitingCustomer === undefined
        ? {}
        : { awaitingCustomer: request.awaitingCustomer }),
      ...(request.color === undefined ? {} : { color: request.color }),
      ...(request.isDefault === undefined ? {} : { isDefault: request.isDefault }),
    });
    /* c8 ignore next 3 -- the read above proved the row is this brand's. */
    if (updated === undefined) {
      throw new NotFoundException('No such status');
    }

    await this.#audit(context, 'ticket_status.updated', statusId, {
      changed: Object.keys(request),
    });

    return toTicketStatus(updated);
  }

  /**
   * What the delete confirmation asks before it asks the person: how many
   * tickets would move, and to which status.
   *
   * It is a read of its own rather than a number returned by the delete,
   * because the artboard's danger link reads "Delete · 12 tickets move to
   * Open" *before* anybody clicks it.
   */
  async usage(tx: DbTransaction, statusId: string): Promise<TicketStatusUsage> {
    const status = await this.#require(tx, statusId);
    const fallback = await this.#requireDefaultOpen(tx);

    return {
      statusId: status.id,
      ticketCount: await this.#lifecycle.countTicketsWithStatus(tx, status.id),
      fallbackStatusId: fallback.id,
      fallbackName: fallback.name,
    };
  }

  /**
   * Deletes a custom status and moves whatever was in it to the brand's
   * default open status.
   *
   * Moving rather than refusing is the choice DOMAIN-RULES leaves open, and it
   * is the one the artboard drew: a desk that cannot delete "Waiting on
   * supplier" until it has hand-moved forty tickets will keep the status
   * forever. Each moved ticket gets an activity row naming the change and an
   * outbox event, because a ticket whose status changed under a queue somebody
   * is watching has to appear to change.
   */
  async remove(context: TicketingSettingsContext, statusId: string): Promise<void> {
    const status = await this.#require(context.tx, statusId);
    this.#refuse(statusDeleteRefusal(status));

    const fallback = await this.#requireDefaultOpen(context.tx);
    const moved = await this.#lifecycle.moveTicketsToStatus(context.tx, statusId, fallback.id);

    for (const ticket of moved) {
      await writeTicketActivity(context.tx, {
        brandId: context.brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        actor: context.actor,
        action: 'ticket.status.changed',
        from: { statusId },
        to: { statusId: fallback.id, reason: 'status-deleted' },
      });

      await enqueueTicketEvent(context.tx, context.brandId, TICKET_EVENTS.updated, {
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
      });
    }

    await this.#lifecycle.deleteStatus(context.tx, statusId);

    await this.#audit(context, 'ticket_status.deleted', statusId, {
      name: status.name,
      movedTickets: moved.length,
      movedTo: fallback.id,
    });
  }

  /**
   * The whole list in its new order. A partial one is refused by the schema,
   * and an id this brand does not have is ignored rather than raising: the
   * order is cosmetic, and a client holding a list one status out of date
   * should not be told its whole request failed.
   */
  async reorder(
    context: TicketingSettingsContext,
    request: TicketStatusReorderRequest,
  ): Promise<TicketStatusList> {
    const known = new Set((await this.#lifecycle.listStatuses(context.tx)).map((row) => row.id));

    let position = 0;
    for (const statusId of request.statusIds) {
      if (!known.has(statusId)) {
        continue;
      }
      await this.#lifecycle.setStatusOrder(context.tx, statusId, position);
      position += 1;
    }

    await this.#audit(context, 'ticket_status.reordered', context.brandId, {
      order: request.statusIds,
    });

    return this.list(context.tx);
  }

  // ---------------------------------------------------------- reply behaviour

  /**
   * `autoAwaitOnAgentReply` and `reopenPolicy`, and nothing else in
   * `brands.settings`.
   *
   * The object is read, merged and written back rather than replaced, so a key
   * a later milestone adds is not reset by a screen that predates it — the
   * opposite of `PATCH /api/brands/:brandId`, which takes `settings` whole
   * because the screen there holds the whole object.
   */
  async updateReplyBehaviour(
    context: TicketingSettingsContext,
    request: ReplyBehaviourUpdateRequest,
  ): Promise<Brand['settings']> {
    return this.#mergeSettings(context, 'brand.reply_behaviour.updated', request);
  }

  // ----------------------------------------------------------------- feedback

  /**
   * The three toggles of the Feedback tab (M1-12), merged into the stored
   * object the way {@link updateReplyBehaviour} merges its two.
   */
  async updateFeedback(
    context: TicketingSettingsContext,
    request: FeedbackSettingsUpdateRequest,
  ): Promise<Brand['settings']> {
    return this.#mergeSettings(context, 'brand.feedback.updated', request);
  }

  // ---------------------------------------------------------------- internals

  async #mergeSettings(
    context: TicketingSettingsContext,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<Brand['settings']> {
    const current = await this.#lifecycle.brandSettings(context.tx, context.brandId);
    /* c8 ignore next 3 -- the permission guard resolved this brand from a role in it. */
    if (current === undefined) {
      throw new NotFoundException('No such brand');
    }

    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined),
    );
    const settings = parseBrandSettings({ ...current, ...defined });

    await this.#lifecycle.updateBrandSettings(context.tx, context.brandId, settings);
    await this.#audit(context, action, context.brandId, { changed: Object.keys(defined) });

    return settings;
  }

  async #require(tx: DbTransaction, statusId: string): Promise<TicketStatusRow> {
    const status = await this.#lifecycle.findStatus(tx, statusId);
    if (status === undefined) {
      // A status of another brand is invisible to this transaction, so "there
      // is no such id" and "it is not yours" are the same answer.
      throw new NotFoundException('No such status');
    }

    return status;
  }

  async #requireDefaultOpen(tx: DbTransaction): Promise<TicketStatusRow> {
    const status = await this.#lifecycle.defaultOpenStatus(tx);
    if (status === undefined) {
      throw new ConflictException('This brand has no default ticket status');
    }

    return status;
  }

  async #assertNameFree(tx: DbTransaction, name: string, exceptId?: string): Promise<void> {
    if (await this.#lifecycle.statusNameTaken(tx, name, exceptId)) {
      throw new TicketingFailure('name-taken');
    }
  }

  #refuse(reason: TicketingRefusal | null): void {
    if (reason !== null) {
      throw new TicketingFailure(reason);
    }
  }

  async #audit(
    context: TicketingSettingsContext,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.#lifecycle.writeAudit(context.tx, {
      brandId: context.brandId,
      actorType: context.actor.actorType,
      actorId: context.actor.actorId,
      action,
      targetType: action.startsWith('brand.') ? 'brand' : 'ticket_status',
      targetId,
      meta,
    });
  }
}
