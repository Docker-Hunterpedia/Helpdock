import type { DbTransaction, Tag as TagRow } from '@helpdock/db';
import type {
  TagCreateRequest,
  TagList,
  TagReorderRequest,
  TagSummary,
  TagUpdateRequest,
  TagUsage,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from './audit.js';
import type { TagsRepository, TagWithCount } from './tags.repository.js';
import type { TicketingContext } from './ticketing-context.js';

/**
 * A brand's tags (M1-06), the Tags tab of the Ticketing settings screen.
 *
 * The same three rules the departments service works under. The transaction is
 * the caller's, so reads are already narrowed by row-level security and the
 * audit row rolls back with whatever it was about. A refusal is a code, never a
 * sentence. And who may do it is decided in one place — here that is the
 * `ticketing:manage` permission alone, because a tag list belongs to the brand
 * rather than to a department and there is nothing left for a scope check to
 * narrow.
 *
 * **Deleting a tag detaches it.** `ticket_tags.tag_id` cascades, so the tickets
 * stay and lose one chip. Nothing refuses the delete, which is exactly why the
 * confirmation reads the count first: the decision is the person's, so they
 * have to be told what it costs.
 */
export class TagsService {
  readonly #repository: TagsRepository;

  constructor(repository: TagsRepository) {
    this.#repository = repository;
  }

  /**
   * Readable by anybody who may read a ticket: the chip picker in the details
   * panel and this settings tab are the same list, and a second endpoint for
   * the same rows would be a second answer to "what tags does this brand have?".
   */
  async list(tx: DbTransaction): Promise<TagList> {
    const rows = await this.#repository.list(tx);

    return { tags: rows.map(toSummary) };
  }

  async usage(tx: DbTransaction, tagId: string): Promise<TagUsage> {
    await this.#require(tx, tagId);

    return { tagId, ticketCount: await this.#repository.ticketCount(tx, tagId) };
  }

  async create(context: TicketingContext, request: TagCreateRequest): Promise<TagSummary> {
    await this.#assertNameFree(context.tx, request.name);

    const tag = await this.#repository.create(context.tx, {
      brandId: context.brandId,
      name: request.name,
      nameAr: request.nameAr ?? null,
      color: request.color,
      sortOrder: await this.#repository.nextSortOrder(context.tx),
    });

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'tag.created',
      targetType: 'tag',
      targetId: tag.id,
      meta: { name: tag.name, color: tag.color },
    });

    return { ...toTag(tag), sortOrder: tag.sortOrder, ticketCount: 0 };
  }

  async update(
    context: TicketingContext,
    tagId: string,
    request: TagUpdateRequest,
  ): Promise<TagSummary> {
    const tag = await this.#require(context.tx, tagId);

    if (request.name !== undefined && !sameName(request.name, tag.name)) {
      await this.#assertNameFree(context.tx, request.name, tagId);
    }

    await this.#repository.update(context.tx, tagId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
      ...(request.color === undefined ? {} : { color: request.color }),
    });

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'tag.updated',
      targetType: 'tag',
      targetId: tagId,
      meta: {
        ...(request.name === undefined ? {} : { name: request.name, wasNamed: tag.name }),
        ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
        ...(request.color === undefined ? {} : { color: request.color, wasColored: tag.color }),
      },
    });

    return this.#summaryOf(context.tx, tagId);
  }

  /**
   * Deletes the tag and detaches it from every ticket that carried it. The
   * count goes into the audit row because afterwards it is the only record of
   * how much was taken off.
   */
  async remove(context: TicketingContext, tagId: string): Promise<void> {
    const tag = await this.#require(context.tx, tagId);
    const ticketCount = await this.#repository.ticketCount(context.tx, tagId);

    await this.#repository.delete(context.tx, tagId);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'tag.deleted',
      targetType: 'tag',
      targetId: tagId,
      meta: { name: tag.name, detachedFrom: ticketCount },
    });
  }

  /**
   * The whole list in its new order. Ids the brand does not have are refused
   * rather than ignored, as a department reorder is and for the same reason: a
   * stale client would otherwise get a silent partial reorder and no way to
   * tell.
   */
  async reorder(context: TicketingContext, request: TagReorderRequest): Promise<TagList> {
    const known = new Set((await this.#repository.list(context.tx)).map((row) => row.tag.id));
    const unique = new Set(request.tagIds);

    if (unique.size !== request.tagIds.length) {
      throw new BadRequestException('The order names a tag twice');
    }
    if (unique.size !== known.size || request.tagIds.some((id) => !known.has(id))) {
      throw new BadRequestException('The order must name every tag of this brand exactly once');
    }

    await this.#repository.reorder(context.tx, request.tagIds);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'tag.reordered',
      targetType: 'brand',
      targetId: context.brandId,
      meta: { order: request.tagIds },
    });

    return this.list(context.tx);
  }

  /**
   * The ids in `tagIds` that are not this brand's, for a caller about to write
   * them onto a ticket. Empty means every id is known. The foreign key would
   * refuse a stranger's id too, but with an error nobody can read and after the
   * transaction has already been spoiled.
   */
  async unknownIds(tx: DbTransaction, tagIds: readonly string[]): Promise<readonly string[]> {
    const known = await this.#repository.existing(tx, tagIds);

    return [...new Set(tagIds)].filter((id) => !known.has(id));
  }

  // ------------------------------------------------------------------

  async #require(tx: DbTransaction, tagId: string): Promise<TagRow> {
    const tag = await this.#repository.find(tx, tagId);
    if (tag === undefined) {
      // A tag of another brand is invisible to this transaction, so "not found"
      // is the honest answer to both "there is no such id" and "not yours".
      throw new NotFoundException('No such tag');
    }

    return tag;
  }

  async #summaryOf(tx: DbTransaction, tagId: string): Promise<TagSummary> {
    const row = (await this.#repository.list(tx)).find((candidate) => candidate.tag.id === tagId);
    /* c8 ignore next 3 -- it was read in this transaction a statement ago. */
    if (row === undefined) {
      throw new NotFoundException('No such tag');
    }

    return toSummary(row);
  }

  /**
   * The unique index on `(brand_id, lower(name))` is what actually enforces
   * this; the read is what turns it into a sentence the screen can translate.
   * A violation that slips past the read — two requests creating "Refund" in
   * the same instant — is refused by the index, which is the answer that must
   * not be missed.
   */
  async #assertNameFree(tx: DbTransaction, name: string, exceptId?: string): Promise<void> {
    const taken = await this.#repository.nameTaken(
      tx,
      name,
      exceptId === undefined ? {} : { exceptId },
    );
    if (taken) {
      throw new TicketingFailure('name-taken');
    }
  }
}

/** The comparison the unique index makes, in TypeScript. */
const sameName = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const toTag = (row: TagRow) => ({
  id: row.id,
  name: row.name,
  nameAr: row.nameAr,
  color: row.color,
});

const toSummary = ({ tag, ticketCount }: TagWithCount): TagSummary => ({
  ...toTag(tag),
  sortOrder: tag.sortOrder,
  ticketCount,
});
