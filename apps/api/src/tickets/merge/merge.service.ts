import type {
  Attachment as AttachmentRow,
  DbTransaction,
  TicketMessage as TicketMessageRow,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { createI18n } from '@helpdock/i18n';
import type {
  TicketDetail,
  TicketMergeRequest,
  TicketMergeResult,
  TicketSplitRequest,
} from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { principalHasPermission } from '../../auth/permissions.js';
import type { Principal } from '../../auth/principal.js';
import { getTx } from '../../context/request-context.js';
import { MediaRepository } from '../../media/media.repository.js';
import { replaceTicketTags, tagsOfTicket } from '../../ticketing/ticket-tags.js';
import { TicketLifecycleHooks } from '../lifecycle/hooks.js';
import { TicketLifecycleRepository } from '../lifecycle/lifecycle.repository.js';
import {
  escalateIntoUnseenDepartment,
  type LifecycleContext,
} from '../lifecycle/lifecycle.service.js';
import { TicketLifecycleFailure } from '../lifecycle/lifecycle-failure.js';
import { activityActorFor, writeTicketActivity } from '../ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../ticket-events.js';
import { toTicket } from '../ticket-view.js';
import { TicketRepository, type TicketWithStatus } from '../tickets.repository.js';
import { TicketsService } from '../tickets.service.js';
import { MergeRepository } from './merge.repository.js';
import {
  addedContact,
  closedAtOnMerge,
  closedAtOnUnmerge,
  copyableAttachments,
  mergedDuration,
  mergeRefusal,
  type SplitProblem,
  splitSelection,
  unmergeRefusal,
} from './merge-rules.js';
import { MergeParticipantsHook } from './participants.hook.js';

/**
 * [DOMAIN-RULES §2.4](../../../../../docs/planning/DOMAIN-RULES.md#24-merge-and-split),
 * carried out: merge, unmerge within 24 hours, and split.
 *
 * The rules are `merge-rules.ts`; this is where rows are written. The
 * discipline of the rest of the ticket code holds throughout:
 *
 * - **Isolation is the database's.** Both tickets are read through the
 *   request's transaction, so a primary in a department the actor cannot read
 *   is a 404 exactly like one that does not exist.
 * - **Every change leaves an activity row and an outbox row** in the same
 *   transaction, on *both* tickets, so each thread can answer "where did this
 *   go?" and each open screen hears `ticket:changed`.
 * - **Clocks and participants are other milestones'.** A merge tells M3-02 and
 *   M1-13 what happened through the hooks, inside the transaction, and writes
 *   none of their rows itself.
 *
 * **A merge moves the secondary into the primary's department.** That is the
 * one decision here §2.4 does not spell out, and it is what makes "access
 * follows the primary ticket after merge" true: the secondary's thread and
 * attachments move with it (`helpdock_ticket_department_moved`), and the
 * `tickets_merged_follow_primary` trigger keeps them following if the primary
 * moves later. Everyone who can read the primary can therefore read the
 * messages shown inline in it, under the ordinary policy. Unmerge moves the
 * secondary back.
 */

/** One of §2.4's system messages: which sentence, in which thread, naming which ticket. */
interface SystemMessage {
  readonly into: TicketRow;
  readonly key: 'mergedFrom' | 'unmerged' | 'splitTo' | 'splitFrom';
  readonly other: TicketRow;
}

/** The same verb on both tickets, with what each side of it adds. */
interface ActivityPair {
  readonly action: 'ticket.merged' | 'ticket.split';
  /** The ticket giving up messages: the secondary, or the original of a split. */
  readonly from: TicketRow;
  /** The ticket receiving them: the primary, or the new ticket. */
  readonly to: TicketRow;
  readonly fromDetail?: Record<string, unknown>;
  readonly toDetail?: Record<string, unknown>;
}

/** Why a split's selection was refused, as the status code that says so. */
const SPLIT_REFUSALS: Readonly<Record<SplitProblem, () => Error>> = {
  not_found: () => new NotFoundException('No such message on this ticket'),
  system_message: () => new BadRequestException('A system message cannot be split'),
  'attachments-in-flight': () => new TicketLifecycleFailure('attachments-in-flight'),
};

@Injectable()
export class MergeService {
  readonly #tickets: TicketRepository;
  readonly #lifecycle: TicketLifecycleRepository;
  readonly #hooks: TicketLifecycleHooks;
  readonly #participants: MergeParticipantsHook;
  readonly #attachments: MediaRepository;
  readonly #merges: MergeRepository;
  readonly #reads: TicketsService;

  constructor(
    @Inject(TicketRepository) tickets: TicketRepository,
    @Inject(TicketLifecycleRepository) lifecycle: TicketLifecycleRepository,
    @Inject(TicketLifecycleHooks) hooks: TicketLifecycleHooks,
    @Inject(MergeParticipantsHook) participants: MergeParticipantsHook,
    @Inject(MediaRepository) attachments: MediaRepository,
    @Inject(MergeRepository) merges: MergeRepository,
    @Inject(TicketsService) reads: TicketsService,
  ) {
    this.#tickets = tickets;
    this.#lifecycle = lifecycle;
    this.#hooks = hooks;
    this.#participants = participants;
    this.#attachments = attachments;
    this.#merges = merges;
    this.#reads = reads;
  }

  // -------------------------------------------------------------------- merge

  async merge(
    brandId: string,
    principal: Principal,
    secondaryId: string,
    { primaryTicketId }: TicketMergeRequest,
  ): Promise<TicketMergeResult> {
    const context = contextFor(brandId, principal);
    const { tx } = context;

    await this.#merges.lockTickets(tx, [secondaryId, primaryTicketId]);
    const secondary = await this.#require(tx, secondaryId);
    const primary = await this.#require(tx, primaryTicketId);

    const refusal = mergeRefusal(
      { ...secondary.ticket, systemState: secondary.status.systemState },
      { ...primary.ticket, systemState: primary.status.systemState },
    );
    if (refusal !== null) {
      throw new TicketLifecycleFailure(refusal);
    }

    const merged = await this.#requireMergedStatus(tx);
    const moved = await this.#closeIntoPrimary(context, {
      secondary,
      primary: primary.ticket,
      merged,
      mergedById: principal.type === 'staff' ? principal.id : null,
    });
    await this.#unionTags(context, primary.ticket, secondaryId);
    const primaryAfter = await this.#touch(tx, primary.ticket.id);

    await this.#hooks.onMerged(tx, { brandId, ticket: moved, status: merged, at: context.now });
    const contactId = addedContact(primary.ticket, secondary.ticket);
    if (contactId !== null) {
      await this.#participants.onContactMerged(tx, {
        brandId,
        primary: primaryAfter,
        secondary: moved,
        contactId,
        principal,
        at: context.now,
      });
    }

    await this.#announce(context, moved, secondary.ticket.departmentId);
    await this.#announce(context, primaryAfter, primaryAfter.departmentId);

    return {
      primary: toTicket(primaryAfter, primary.status, await tagsOfTicket(tx, primaryAfter.id)),
      secondary: toTicket(moved, merged, await tagsOfTicket(tx, secondaryId)),
    };
  }

  // ------------------------------------------------------------------ unmerge

  /**
   * "Merge is reversible for 24 hours (unmerge restores the secondary to its
   * previous status; clocks resume with time paused during the merge
   * excluded)."
   *
   * The secondary also goes back to the department it was merged from. When
   * that department is outside the actor's own scope — a Billing agent undoing
   * a merge an Admin made from Support — the move is the escalation §1.2
   * already allows, made in the same widened window `PATCH` uses.
   *
   * The primary keeps the tags the merge gave it: §2.4 does not say they go,
   * and nothing records which of them the primary would not otherwise have
   * carried by now.
   */
  async unmerge(
    brandId: string,
    principal: Principal,
    secondaryId: string,
  ): Promise<TicketMergeResult> {
    const context = contextFor(brandId, principal);
    const { tx } = context;

    await this.#merges.lockTickets(tx, [secondaryId]);
    const secondary = await this.#require(tx, secondaryId);
    const { ticket } = secondary;

    const refusal = unmergeRefusal(ticket, context.now);
    // The two nulls are what the refusal has already ruled out; restating them
    // is what lets the compiler see it.
    if (refusal !== null || ticket.mergedIntoId === null || ticket.mergedAt === null) {
      throw new TicketLifecycleFailure(refusal ?? 'ticket-not-merged');
    }

    const primary = await this.#tickets.findTicket(tx, ticket.mergedIntoId);
    if (primary === undefined) {
      // A secondary always sits in its primary's department (the follow-the-
      // primary trigger), so a reader of this one could read that one: the
      // only way it is missing is an Admin's soft delete. Saying so is not a
      // leak, and a 404 would claim the ticket in the path does not exist. A
      // deleted ticket is not acted on (§2.2), so the merge stays.
      throw new TicketLifecycleFailure('merge-primary-deleted');
    }
    const restored = await this.#restoredStatus(tx, ticket.preMergeStatusId);
    const mergedMs = mergedDuration(ticket.mergedAt, context.now);
    const moved = await this.#restoreSecondary(context, { secondary, restored, mergedMs });

    await this.#writeSystemMessage(context, {
      into: primary.ticket,
      key: 'unmerged',
      other: ticket,
    });
    await writeTicketActivity(tx, {
      brandId,
      ticketId: primary.ticket.id,
      departmentId: primary.ticket.departmentId,
      actor: context.actor,
      action: 'ticket.unmerged',
      from: { ticketId: secondaryId },
      to: { ticketId: primary.ticket.id, mergedMs },
    });
    const primaryAfter = await this.#touch(tx, primary.ticket.id);

    const contactId = addedContact(primary.ticket, ticket);
    if (contactId !== null) {
      await this.#participants.onContactUnmerged(tx, {
        brandId,
        primary: primaryAfter,
        secondary: moved,
        contactId,
        principal,
        at: context.now,
      });
    }

    await this.#announce(context, moved, ticket.departmentId);
    await this.#announce(context, primaryAfter, primaryAfter.departmentId);

    return {
      primary: toTicket(primaryAfter, primary.status, await tagsOfTicket(tx, primaryAfter.id)),
      secondary: toTicket(moved, restored, await tagsOfTicket(tx, secondaryId)),
    };
  }

  // -------------------------------------------------------------------- split

  /**
   * "Selected messages → new ticket": `split_from_id`, the same contact, the
   * department the agent chose, a fresh number, the messages **copied** with
   * `copied_from_message_id`, and "Messages split to HD-1103" on the original.
   *
   * "New clocks start at split time under the new ticket's policy": the new
   * ticket is created like any other and announced with `ticket.created`,
   * which is what M3-02's clocks start from. The original's are not touched.
   *
   * The department must be one the actor may file a ticket in, the rule
   * creation already follows: splitting is filing a ticket, not escalating
   * one, and a ticket split into a department its author cannot read would be
   * work nobody meant to hand over.
   */
  async split(
    brandId: string,
    principal: Principal,
    ticketId: string,
    request: TicketSplitRequest,
  ): Promise<TicketDetail> {
    const context = contextFor(brandId, principal);
    const { tx } = context;
    const original = await this.#require(tx, ticketId);

    if (original.ticket.mergedIntoId !== null) {
      throw new TicketLifecycleFailure('ticket-merged');
    }
    if (!(await this.#tickets.departmentIsWritable(tx, request.departmentId))) {
      throw new ForbiddenException('That department is outside your scope');
    }

    const found = await this.#merges.messagesOfTicket(tx, ticketId, request.messageIds);
    const files = await this.#attachments.ofMessages(
      tx,
      found.map((message) => message.id),
    );
    const selection = splitSelection(request.messageIds, found, files);
    if (!selection.ok) {
      throw SPLIT_REFUSALS[selection.problem]();
    }

    const created = await this.#fileSplitTicket(context, original.ticket, request);
    await this.#copyMessages(context, created, selection.messages, files);

    await this.#writeSystemMessage(context, {
      into: created,
      key: 'splitFrom',
      other: original.ticket,
    });
    await this.#writeSystemMessage(context, {
      into: original.ticket,
      key: 'splitTo',
      other: created,
    });
    await this.#recordPair(context, {
      action: 'ticket.split',
      from: original.ticket,
      to: created,
      toDetail: { messageIds: selection.messages.map((message) => message.id) },
    });
    const originalAfter = await this.#touch(tx, original.ticket.id);

    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.created, {
      ticketId: created.id,
      departmentId: created.departmentId,
    });
    await this.#announce(context, originalAfter, originalAfter.departmentId);

    // The embedded contact name follows `contact:read`, as a ticket read does (M1-15).
    return this.#reads.find(created.id, {
      withContacts: principalHasPermission(principal, brandId, 'contact:read'),
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * The secondary's half of a merge: the primary's announcement, then the row
   * itself — closed as Merged, into the primary's department, with what an
   * unmerge will need to put it back — and its two activity rows.
   */
  async #closeIntoPrimary(
    context: LifecycleContext,
    merge: {
      readonly secondary: TicketWithStatus;
      readonly primary: TicketRow;
      readonly merged: TicketStatusRow;
      readonly mergedById: string | null;
    },
  ): Promise<TicketRow> {
    const { ticket, status } = merge.secondary;
    const announcement = await this.#writeSystemMessage(context, {
      into: merge.primary,
      key: 'mergedFrom',
      other: ticket,
    });

    const moved = await this.#tickets.updateTicket(context.tx, ticket.id, {
      statusId: merge.merged.id,
      closedAt: closedAtOnMerge(ticket.closedAt, context.now),
      mergedIntoId: merge.primary.id,
      mergedAt: context.now,
      mergedById: merge.mergedById,
      preMergeStatusId: status.id,
      preMergeDepartmentId: ticket.departmentId,
      mergeMessageId: announcement,
      departmentId: merge.primary.departmentId,
    });
    /* c8 ignore next 3 -- the row was read and locked through this transaction. */
    if (moved === undefined) {
      throw new ConflictException('That ticket moved while it was being merged');
    }

    await this.#recordPair(context, {
      action: 'ticket.merged',
      from: ticket,
      to: merge.primary,
      fromDetail: { statusId: status.id, departmentId: ticket.departmentId },
      toDetail: { statusId: merge.merged.id, departmentId: moved.departmentId },
    });
    await this.#logStatusChange(context, moved, status.id, merge.merged.id);

    return moved;
  }

  /**
   * The secondary's half of an unmerge, inside the widened window when the
   * department it goes back to is one the actor cannot see — every write that
   * follows the move has to be, because the trigger files it under the new
   * department.
   */
  async #restoreSecondary(
    context: LifecycleContext,
    unmerge: {
      readonly secondary: TicketWithStatus;
      readonly restored: TicketStatusRow;
      readonly mergedMs: number;
    },
  ): Promise<TicketRow> {
    const { ticket, status } = unmerge.secondary;
    const departmentId = ticket.preMergeDepartmentId ?? ticket.departmentId;

    const write = async (): Promise<TicketRow> => {
      const moved = await this.#tickets.updateTicket(context.tx, ticket.id, {
        statusId: unmerge.restored.id,
        closedAt: closedAtOnUnmerge(unmerge.restored, ticket.closedAt),
        mergedIntoId: null,
        mergedAt: null,
        mergedById: null,
        preMergeStatusId: null,
        preMergeDepartmentId: null,
        mergeMessageId: null,
        mergedMs: ticket.mergedMs + unmerge.mergedMs,
        departmentId,
      });
      /* c8 ignore next 3 -- the row was read and locked through this transaction. */
      if (moved === undefined) {
        throw new ConflictException('That ticket moved while it was being unmerged');
      }

      await writeTicketActivity(context.tx, {
        brandId: context.brandId,
        ticketId: ticket.id,
        departmentId: moved.departmentId,
        actor: context.actor,
        action: 'ticket.unmerged',
        from: { ticketId: ticket.id, statusId: status.id, departmentId: ticket.departmentId },
        to: {
          ticketId: ticket.mergedIntoId,
          statusId: unmerge.restored.id,
          departmentId,
          mergedMs: unmerge.mergedMs,
        },
      });
      await this.#logStatusChange(context, moved, status.id, unmerge.restored.id);
      await this.#hooks.onUnmerged(context.tx, {
        brandId: context.brandId,
        ticket: moved,
        status: unmerge.restored,
        at: context.now,
        mergedMs: unmerge.mergedMs,
      });

      return moved;
    };

    const outOfScope =
      departmentId !== ticket.departmentId &&
      !(await this.#tickets.departmentIsWritable(context.tx, departmentId));

    return outOfScope ? escalateIntoUnseenDepartment(context.tx, departmentId, write) : write();
  }

  /** The new ticket of a split, and its `ticket.created` activity row. */
  async #fileSplitTicket(
    context: LifecycleContext,
    original: TicketRow,
    request: TicketSplitRequest,
  ): Promise<TicketRow> {
    const status = await this.#requireDefaultStatus(context.tx);
    const prefix =
      (await this.#tickets.brandPrefix(context.tx, context.brandId)) ?? original.prefix;
    const created = await this.#tickets.insertTicket(context.tx, {
      brandId: context.brandId,
      departmentId: request.departmentId,
      number: await this.#tickets.nextNumber(context.tx, context.brandId),
      prefix,
      subject: request.subject,
      statusId: status.id,
      priority: request.priority ?? original.priority,
      channel: original.channel,
      splitFromId: original.id,
      ...(original.contactId === null ? {} : { contactId: original.contactId }),
    });

    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: created.id,
      departmentId: created.departmentId,
      actor: context.actor,
      action: 'ticket.created',
      to: {
        subject: created.subject,
        statusId: status.id,
        priority: created.priority,
        splitFromId: original.id,
      },
    });

    return created;
  }

  /**
   * The copies, oldest first. Each keeps its original `created_at` — the
   * customer wrote it when they wrote it, and the new thread reads in the order
   * it happened — and takes the new ticket's own `seq` from 1. Its readable
   * attachments are copied as rows onto the same objects.
   */
  async #copyMessages(
    context: LifecycleContext,
    into: TicketRow,
    messages: readonly TicketMessageRow[],
    files: ReadonlyMap<string, readonly AttachmentRow[]>,
  ): Promise<void> {
    for (const [index, message] of messages.entries()) {
      const copy = await this.#tickets.insertMessage(context.tx, {
        brandId: context.brandId,
        ticketId: into.id,
        departmentId: into.departmentId,
        seq: index + 1,
        kind: message.kind,
        authorType: message.authorType,
        authorId: message.authorId,
        bodyHtml: message.bodyHtml,
        bodyText: message.bodyText,
        channel: message.channel,
        copiedFromMessageId: message.id,
        createdAt: message.createdAt,
      });
      await this.#merges.insertAttachmentCopies(
        context.tx,
        {
          brandId: context.brandId,
          ticketId: into.id,
          messageId: copy.id,
          departmentId: into.departmentId,
        },
        copyableAttachments(files.get(message.id) ?? []),
      );
    }
  }

  async #require(tx: DbTransaction, ticketId: string): Promise<TicketWithStatus> {
    const found = await this.#tickets.findTicket(tx, ticketId);
    if (found === undefined) {
      // Another department's ticket is invisible to the policy, so this is
      // also the answer to "not yours" (DOMAIN-RULES §1.2).
      throw new NotFoundException('No such ticket');
    }

    return found;
  }

  async #requireMergedStatus(tx: DbTransaction): Promise<TicketStatusRow> {
    const merged = await this.#merges.mergedStatus(tx);
    /* c8 ignore next 4 -- every brand is seeded with it, and a system row cannot be deleted. */
    if (merged === undefined) {
      throw new ConflictException('This brand has no Merged status');
    }

    return merged;
  }

  async #requireDefaultStatus(tx: DbTransaction): Promise<TicketStatusRow> {
    const open = await this.#lifecycle.defaultOpenStatus(tx);
    /* c8 ignore next 3 -- every brand is seeded with its statuses when it is created. */
    if (open === undefined) {
      throw new ConflictException('This brand has no default ticket status');
    }

    return open;
  }

  /**
   * The status the secondary was in before the merge, or the brand's default
   * open status when that one has since been deleted — the fallback a status
   * delete itself moves tickets to.
   */
  async #restoredStatus(tx: DbTransaction, statusId: string | null): Promise<TicketStatusRow> {
    const previous = statusId === null ? undefined : await this.#tickets.findStatus(tx, statusId);

    return previous ?? this.#requireDefaultStatus(tx);
  }

  /** §2.4: "Tags: union." Written as M1-06's own verb, so the thread draws the chips. */
  async #unionTags(
    context: LifecycleContext,
    primary: TicketRow,
    secondaryId: string,
  ): Promise<void> {
    const [mine, theirs] = await Promise.all([
      tagsOfTicket(context.tx, primary.id),
      tagsOfTicket(context.tx, secondaryId),
    ]);
    const change = await replaceTicketTags(context.tx, {
      brandId: context.brandId,
      ticketId: primary.id,
      departmentId: primary.departmentId,
      tagIds: [...mine, ...theirs].map((tag) => tag.id),
    });

    if (change.changed) {
      await writeTicketActivity(context.tx, {
        brandId: context.brandId,
        ticketId: primary.id,
        departmentId: primary.departmentId,
        actor: context.actor,
        action: 'ticket.tags.changed',
        from: { tagIds: change.before },
        to: { tagIds: change.after },
      });
    }
  }

  /**
   * The same verb on both tickets, as `ticket.continued` is written: each
   * thread is half of the answer to "where did this go?".
   */
  async #recordPair(context: LifecycleContext, pair: ActivityPair): Promise<void> {
    const from = { ticketId: pair.from.id, ...pair.fromDetail };
    const to = { ticketId: pair.to.id, ...pair.toDetail };

    for (const ticket of [pair.from, pair.to]) {
      await writeTicketActivity(context.tx, {
        brandId: context.brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        actor: context.actor,
        action: pair.action,
        from,
        to,
      });
    }
  }

  /** The `ticket.status.changed` row every transition writes beside its own verb. */
  async #logStatusChange(
    context: LifecycleContext,
    ticket: TicketRow,
    fromStatusId: string,
    toStatusId: string,
  ): Promise<void> {
    await writeTicketActivity(context.tx, {
      brandId: context.brandId,
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      actor: context.actor,
      action: 'ticket.status.changed',
      from: { statusId: fromStatusId },
      to: { statusId: toStatusId },
    });
  }

  /**
   * One of §2.4's system messages, in the language of the thread's contact —
   * the rule M1-08's "Continued in" follows, for the same reason: it is in a
   * thread the customer may be sent. Returns the message's id.
   */
  async #writeSystemMessage(
    context: LifecycleContext,
    { into, key, other }: SystemMessage,
  ): Promise<string> {
    const locale = await this.#lifecycle.localeForContact(
      context.tx,
      context.brandId,
      into.contactId,
    );
    const t = createI18n({ lng: locale }).getFixedT(locale, 'ticket');
    const text = t(`system.${key}`, { ticket: `${other.prefix}-${other.number}` });

    const message = await this.#tickets.insertMessage(context.tx, {
      brandId: context.brandId,
      ticketId: into.id,
      departmentId: into.departmentId,
      seq: await this.#tickets.nextSeq(context.tx, into.id),
      kind: 'system',
      authorType: 'system',
      authorId: context.actor.actorId,
      // A ticket number and a fixed sentence: nothing a person typed.
      bodyHtml: `<p>${text}</p>`,
      bodyText: text,
      channel: into.channel,
    });

    return message.id;
  }

  /** Bumps `updated_at`, for the reason a reply does: the list orders by it. */
  async #touch(tx: DbTransaction, ticketId: string): Promise<TicketRow> {
    const touched = await this.#tickets.updateTicket(tx, ticketId, {});
    /* c8 ignore next 3 -- the caller read the ticket through the same transaction. */
    if (touched === undefined) {
      throw new ConflictException('That ticket moved while it was being updated');
    }

    return touched;
  }

  /** `ticket:changed` to the ticket's room and its queue — and the queue it left. */
  async #announce(
    context: LifecycleContext,
    ticket: TicketRow,
    previousDepartmentId: string,
  ): Promise<void> {
    await enqueueTicketEvent(context.tx, context.brandId, TICKET_EVENTS.updated, {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      ...(previousDepartmentId === ticket.departmentId ? {} : { previousDepartmentId }),
    });
  }
}

/** One request's transaction, actor and instant, shared by every write it makes. */
const contextFor = (brandId: string, principal: Principal): LifecycleContext => ({
  tx: getTx(),
  brandId,
  actor: activityActorFor(principal),
  now: new Date(),
});
