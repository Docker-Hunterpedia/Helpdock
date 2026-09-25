import type { Settings } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import type {
  BlockedSender,
  BlockedSenderCreateRequest,
  BlockedSenderList,
  BrandSettings,
  SpamSettingsUpdateRequest,
} from '@helpdock/schemas';
import { domainOfAddress, normaliseBlockedSender, normaliseEmail } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from './audit.js';
import type { BlockedSenderWithAuthor, BlockListRepository } from './block-list.repository.js';
import { isOwnSender, type OwnSenders, type SenderKey } from './block-rules.js';
import type { TicketingContext } from './ticketing-context.js';

/**
 * A brand's sender block list and the Spam tab's one setting (M1-11).
 *
 * The same three rules as the rest of this module: the transaction is the
 * caller's, so reads are narrowed by row-level security and an audit row rolls
 * back with its change; a refusal is a code, never a sentence; and who may do
 * it is decided by the route — `ticketing:manage` for the tab, `ticket:write`
 * for "Mark as spam", which reaches {@link blockFromTicket} and nothing else.
 *
 * **What a brand sends from** is read at the moment it matters, not cached:
 * the install's `smtp.from` address and its domain, and every hostname in
 * `brand_domains`. M2's per-brand mailboxes join the list when they exist
 * (`docs/guides/ticketing-settings.md` records the gap).
 */
export class BlockListService {
  readonly #repository: BlockListRepository;
  readonly #settings: Settings;

  constructor(repository: BlockListRepository, settings: Settings) {
    this.#repository = repository;
    this.#settings = settings;
  }

  async list(tx: DbTransaction): Promise<BlockedSenderList> {
    const rows = await this.#repository.list(tx);

    return { senders: rows.map(toBlockedSender) };
  }

  /** "Block a sender" on the Spam tab. A sender already blocked is refused, not repeated. */
  async create(
    context: TicketingContext,
    request: BlockedSenderCreateRequest,
  ): Promise<BlockedSender> {
    const key = await this.#normalise(request.kind, request.value);
    await this.#refuseOwn(context.tx, key);

    const created = await this.#insert(context, key, null);
    if (created === undefined) {
      throw new TicketingFailure('sender-already-blocked');
    }

    return created;
  }

  /**
   * The "Block sender" half of "Mark as spam". Idempotent where {@link create}
   * refuses: an agent ticking the box on a second ticket from a sender somebody
   * already blocked has asked for what is already true.
   */
  async blockFromTicket(
    context: TicketingContext,
    sender: SenderKey,
    ticketId: string,
  ): Promise<string> {
    const key = await this.#normalise(sender.kind, sender.value);
    await this.#refuseOwn(context.tx, key);

    const created = await this.#insert(context, key, ticketId);
    if (created !== undefined) {
      return created.id;
    }

    const [existing] = await this.#repository.matching(context.tx, context.brandId, [key]);
    /* c8 ignore next 3 -- the insert just conflicted with this very row. */
    if (existing === undefined) {
      throw new Error('A block-list insert conflicted with a row that is not there');
    }

    return existing.id;
  }

  async remove(context: TicketingContext, id: string): Promise<void> {
    const found = await this.#repository.find(context.tx, id);
    if (found === undefined) {
      throw new NotFoundException('No such blocked sender');
    }

    await this.#repository.delete(context.tx, id);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'blocked_sender.deleted',
      targetType: 'blocked_sender',
      targetId: id,
      // The counter goes into the trail because afterwards it is the only
      // record of how much the block had been doing.
      meta: { kind: found.sender.kind, droppedCount: found.sender.droppedCount },
    });
  }

  /** Whether blocking this sender would block the brand's own mail. */
  async isOwn(tx: DbTransaction, sender: SenderKey): Promise<boolean> {
    return isOwnSender(sender, await this.#ownSenders(tx));
  }

  /** Whether this exact sender is on the list already. */
  async isListed(tx: DbTransaction, brandId: string, sender: SenderKey): Promise<boolean> {
    return (await this.#repository.matching(tx, brandId, [sender])).length > 0;
  }

  async settings(tx: DbTransaction, brandId: string): Promise<BrandSettings> {
    const settings = await this.#repository.brandSettings(tx, brandId);
    /* c8 ignore next 3 -- the permission guard resolved this brand from a role in it. */
    if (settings === undefined) {
      throw new NotFoundException('No such brand');
    }

    return settings;
  }

  /** The Spam tab's card. `ticketing:manage`, like the rest of the tab. */
  async updateSettings(
    context: TicketingContext,
    request: SpamSettingsUpdateRequest,
  ): Promise<BrandSettings> {
    const current = await this.settings(context.tx, context.brandId);
    const next: BrandSettings = { ...current, offerBlockSender: request.offerBlockSender };

    await this.#repository.updateBrandSettings(context.tx, context.brandId, next);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'brand.spam_settings.updated',
      targetType: 'brand',
      targetId: context.brandId,
      meta: { offerBlockSender: request.offerBlockSender },
    });

    return next;
  }

  // ------------------------------------------------------------------

  /**
   * The stored spelling, or `sender-invalid`. A phone number without a `+` is
   * completed with the brand's calling code (ADR 0008) — install-wide until
   * per-brand settings resolve, exactly as `ContactsService` reads it.
   */
  async #normalise(kind: SenderKey['kind'], value: string): Promise<SenderKey> {
    const defaultCallingCode =
      kind === 'phone' ? await this.#settings.get('contacts.defaultCallingCode') : '';
    const result = normaliseBlockedSender(kind, value, { defaultCallingCode });
    if (!result.ok) {
      throw new TicketingFailure('sender-invalid');
    }

    return { kind, value: result.value };
  }

  async #refuseOwn(tx: DbTransaction, key: SenderKey): Promise<void> {
    if (await this.isOwn(tx, key)) {
      throw new TicketingFailure('sender-is-own');
    }
  }

  async #ownSenders(tx: DbTransaction): Promise<OwnSenders> {
    const from = normaliseEmail(await this.#settings.get('smtp.from'));
    const hostnames = await this.#repository.brandDomains(tx);

    return from.ok
      ? { addresses: [from.value], domains: [domainOfAddress(from.value), ...hostnames] }
      : { addresses: [], domains: hostnames };
  }

  async #insert(
    context: TicketingContext,
    key: SenderKey,
    sourceTicketId: string | null,
  ): Promise<BlockedSender | undefined> {
    const row = await this.#repository.insert(context.tx, {
      brandId: context.brandId,
      kind: key.kind,
      value: key.value,
      createdBy: context.actor.userId,
      sourceTicketId,
    });
    if (row === undefined) {
      return undefined;
    }

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'blocked_sender.created',
      targetType: 'blocked_sender',
      targetId: row.id,
      // The kind and never the value: an address is personal data, and the
      // audit log outlives the block (DOMAIN-RULES §11).
      meta: { kind: key.kind, ...(sourceTicketId === null ? {} : { sourceTicketId }) },
    });

    const found = await this.#repository.find(context.tx, row.id);
    /* c8 ignore next 3 -- it was inserted in this transaction a statement ago. */
    if (found === undefined) {
      throw new NotFoundException('No such blocked sender');
    }

    return toBlockedSender(found);
  }
}

const toBlockedSender = ({ sender, createdByName }: BlockedSenderWithAuthor): BlockedSender => ({
  id: sender.id,
  kind: sender.kind,
  value: sender.value,
  createdByName,
  sourceTicketId: sender.sourceTicketId,
  droppedCount: sender.droppedCount,
  lastDroppedAt: sender.lastDroppedAt?.toISOString() ?? null,
  createdAt: sender.createdAt.toISOString(),
});
