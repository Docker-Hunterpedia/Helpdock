import { safeMessageId } from '@helpdock/channels';
import {
  brands,
  contactIdentities,
  contacts,
  type DbTransaction,
  departments,
  type EmailDelivery,
  type EmailOutboundSettings,
  emailDeliveries,
  emailOutboundSettings,
  mailboxes,
  type NewEmailDelivery,
  type NewEmailOutboundSettings,
  ticketMessages,
  ticketParticipants,
  ticketStatuses,
  tickets,
  users,
} from '@helpdock/db';
import { emailMessageMetaSchema, publicNameOf } from '@helpdock/schemas';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';

/**
 * M2-05 and M2-06's reads and writes. Stateless: every method takes the
 * transaction it runs in, the request's or the job's, so isolation is the
 * policies' and never a `WHERE brand_id` here (DOMAIN-RULES §1.3).
 */

/** A brand's outbound row with the columns each tab section writes. */
export type SettingsPatch = Omit<Partial<NewEmailOutboundSettings>, 'brandId'>;

/** Everything the `email.send` job needs to render one message. */
export interface SendFacts {
  readonly ticket: {
    readonly id: string;
    readonly reference: string;
    readonly subject: string;
    readonly contactId: string | null;
  };
  readonly brandName: string;
  readonly departmentName: string;
  readonly contactName: string | null;
  /** M14-26. A spam ticket is sent no auto-reply and no survey, whenever they were queued. */
  readonly isSpam: boolean;
  readonly message: {
    readonly bodyHtml: string;
    readonly bodyText: string;
    readonly authorId: string | null;
    readonly authorType: string;
  } | null;
  readonly author: EmailAuthor | null;
  /**
   * M14-31. The customer email a reply answers, when it named one and that
   * message is still there: what the quote and the threading headers read.
   */
  readonly replyTarget: ReplyTarget | null;
  /**
   * M4-08. The conversation a transcript carries: its public replies and AI
   * answers in order, never a note or a system row. Empty for every other kind.
   */
  readonly transcript: readonly TranscriptLine[];
}

/**
 * Whoever wrote a reply, as far as the customer's copy of it needs: the name
 * they are known by (M14-12), their title and phone for the signature's
 * placeholders, and the signature itself. The email address is not here.
 */
export interface EmailAuthor {
  /** The full name, which only `{{agent.full_name}}` shows a customer. */
  readonly name: string;
  readonly publicName: string | null;
  readonly jobTitleEn: string | null;
  readonly jobTitleAr: string | null;
  readonly publicPhone: string | null;
  readonly signatureEn: string | null;
  readonly signatureAr: string | null;
}

/** The message a targeted reply threads to and quotes. */
export interface ReplyTarget {
  /** The bare `Message-ID` it arrived with, only when it is safe to write into a header. */
  readonly messageId: string | undefined;
  /** Its `References` chain as it arrived, each entry checked, oldest first. */
  readonly references: readonly string[];
  /** The sender's name, when the message named one. */
  readonly senderName: string | null;
  /** The `Date:` it was written, else when it arrived. */
  readonly sentAt: Date;
  readonly arrivedAt: Date;
  readonly text: string;
}

const authorColumns = {
  name: users.name,
  publicName: users.publicName,
  jobTitleEn: users.jobTitleEn,
  jobTitleAr: users.jobTitleAr,
  publicPhone: users.publicPhone,
  signatureEn: users.signatureEn,
  signatureAr: users.signatureAr,
} as const;

export interface TranscriptLine {
  readonly from: 'visitor' | 'agent';
  /** The agent's public name; null for the visitor. */
  readonly agentName: string | null;
  readonly text: string;
  readonly at: Date;
}

/** What a reply is addressed with, read in the transaction that writes the reply. */
export interface ReplyAddressing {
  readonly ticketId: string;
  readonly departmentId: string;
  /** In the reply's language, for `{{department.name}}` in a signature. */
  readonly departmentName: string;
  readonly contact: { readonly name: string; readonly address: string } | null;
  readonly locale: 'en' | 'ar';
  readonly cc: readonly string[];
  /** M14-26. The mailbox a rule chose to send replies from; null: the department's sender. */
  readonly replyMailbox: {
    readonly id: string;
    readonly name: string;
    readonly address: string;
  } | null;
}

/** `References` stays short enough for any relay; the newest ids are the ones that file a reply. */
const REFERENCES_MAX = 20;

const reference = (prefix: string, number: number): string => `${prefix}-${String(number)}`;

export class EmailRepository {
  // ------------------------------------------------------------- settings

  async settings(tx: DbTransaction, brandId: string): Promise<EmailOutboundSettings | undefined> {
    const [row] = await tx
      .select()
      .from(emailOutboundSettings)
      .where(eq(emailOutboundSettings.brandId, brandId))
      .limit(1);
    return row;
  }

  async saveSettings(tx: DbTransaction, brandId: string, patch: SettingsPatch): Promise<void> {
    const values = { ...patch, updatedAt: new Date() };
    await tx
      .insert(emailOutboundSettings)
      .values({ brandId, ...values })
      .onConflictDoUpdate({ target: emailOutboundSettings.brandId, set: values });
  }

  /** A staff member as the customer's copy of their reply needs them (M14-12). */
  async author(tx: DbTransaction, userId: string): Promise<EmailAuthor | undefined> {
    const [row] = await tx.select(authorColumns).from(users).where(eq(users.id, userId)).limit(1);

    return row;
  }

  async userName(tx: DbTransaction, userId: string): Promise<string | null> {
    const [row] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.name ?? null;
  }

  async userAddress(
    tx: DbTransaction,
    userId: string,
  ): Promise<{ email: string; locale: 'en' | 'ar' } | undefined> {
    const [row] = await tx
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row;
  }

  async brand(
    tx: DbTransaction,
    brandId: string,
  ): Promise<{ name: string; defaultLocale: 'en' | 'ar' } | undefined> {
    const [row] = await tx
      .select({ name: brands.name, defaultLocale: brands.defaultLocale })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    return row;
  }

  async departmentIds(tx: DbTransaction): Promise<ReadonlySet<string>> {
    const rows = await tx.select({ id: departments.id }).from(departments);
    return new Set(rows.map((row) => row.id));
  }

  // ------------------------------------------------------------ signatures

  async signature(
    tx: DbTransaction,
    userId: string,
  ): Promise<{ en: string | null; ar: string | null } | undefined> {
    const [row] = await tx
      .select({ en: users.signatureEn, ar: users.signatureAr })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row;
  }

  async saveSignature(
    tx: DbTransaction,
    userId: string,
    signature: { en: string | null; ar: string | null },
  ): Promise<void> {
    await tx
      .update(users)
      .set({ signatureEn: signature.en, signatureAr: signature.ar })
      .where(eq(users.id, userId));
  }

  // ------------------------------------------------------------ addressing

  /**
   * The contact's address, the ticket's CCs, and the language the reply is
   * written in: the contact's own, else the brand's default. The address is
   * the contact's email identity, verified ones first, as the participants
   * card shows it.
   */
  async replyAddressing(tx: DbTransaction, ticketId: string): Promise<ReplyAddressing | undefined> {
    const [ticket] = await tx
      .select({
        id: tickets.id,
        departmentId: tickets.departmentId,
        departmentName: departments.name,
        departmentNameAr: departments.nameAr,
        contactId: tickets.contactId,
        contactName: contacts.name,
        contactLocale: contacts.locale,
        brandLocale: brands.defaultLocale,
        replyMailboxId: mailboxes.id,
        replyMailboxAddress: mailboxes.address,
        replyMailboxName: mailboxes.displayName,
      })
      .from(tickets)
      .innerJoin(brands, eq(brands.id, tickets.brandId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .leftJoin(contacts, eq(contacts.id, tickets.contactId))
      .leftJoin(
        mailboxes,
        // A mailbox only speaks for the department it belongs to now: after a transfer, or
        // when the mailbox moved, replies fall back to the department's sender.
        and(
          eq(mailboxes.id, tickets.replyMailboxId),
          eq(mailboxes.departmentId, tickets.departmentId),
        ),
      )
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (ticket === undefined) {
      return undefined;
    }

    const address =
      ticket.contactId === null ? null : await this.contactEmail(tx, ticket.contactId);
    const ccRows = await tx
      .select({ address: ticketParticipants.address })
      .from(ticketParticipants)
      .where(and(eq(ticketParticipants.ticketId, ticketId), isNotNull(ticketParticipants.address)))
      .orderBy(asc(ticketParticipants.createdAt));
    const own = address?.toLowerCase();
    const cc = [
      ...new Set(
        ccRows
          .map((row) => row.address?.toLowerCase())
          .filter((value): value is string => value !== undefined && value !== own),
      ),
    ];

    const locale = ticket.contactLocale ?? ticket.brandLocale;

    return {
      ticketId: ticket.id,
      departmentId: ticket.departmentId,
      departmentName:
        locale === 'ar' && ticket.departmentNameAr !== null
          ? ticket.departmentNameAr
          : ticket.departmentName,
      contact: address === null ? null : { name: ticket.contactName ?? '', address },
      locale,
      cc,
      replyMailbox:
        ticket.replyMailboxId === null || ticket.replyMailboxAddress === null
          ? null
          : {
              id: ticket.replyMailboxId,
              name: ticket.replyMailboxName ?? '',
              address: ticket.replyMailboxAddress,
            },
    };
  }

  async contactEmail(tx: DbTransaction, contactId: string): Promise<string | null> {
    const [row] = await tx
      .select({ value: contactIdentities.value })
      .from(contactIdentities)
      .where(and(eq(contactIdentities.contactId, contactId), eq(contactIdentities.kind, 'email')))
      .orderBy(desc(contactIdentities.verified), asc(contactIdentities.createdAt))
      .limit(1);
    return row?.value ?? null;
  }

  // ------------------------------------------------------------ deliveries

  /** Inserts, or returns undefined when the reply or the auto-reply already has one. */
  async insertDelivery(
    tx: DbTransaction,
    values: NewEmailDelivery,
  ): Promise<EmailDelivery | undefined> {
    const [row] = await tx.insert(emailDeliveries).values(values).onConflictDoNothing().returning();
    return row;
  }

  async delivery(tx: DbTransaction, deliveryId: string): Promise<EmailDelivery | undefined> {
    const [row] = await tx
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.id, deliveryId))
      .limit(1);
    return row;
  }

  async deliveryForMessage(
    tx: DbTransaction,
    ticketId: string,
    messageId: string,
  ): Promise<EmailDelivery | undefined> {
    const [row] = await tx
      .select()
      .from(emailDeliveries)
      .where(
        and(eq(emailDeliveries.ticketId, ticketId), eq(emailDeliveries.ticketMessageId, messageId)),
      )
      .limit(1);
    return row;
  }

  async deliveriesForTicket(tx: DbTransaction, ticketId: string): Promise<EmailDelivery[]> {
    return tx
      .select()
      .from(emailDeliveries)
      .where(
        and(eq(emailDeliveries.ticketId, ticketId), isNotNull(emailDeliveries.ticketMessageId)),
      )
      .orderBy(asc(emailDeliveries.createdAt));
  }

  async markSent(tx: DbTransaction, deliveryId: string, at: Date): Promise<void> {
    await tx
      .update(emailDeliveries)
      .set({ status: 'sent', sentAt: at, lastError: null, failedAt: null })
      .where(eq(emailDeliveries.id, deliveryId));
  }

  /** One failed attempt; `dead` when it was the last, which dead-letters the row. */
  async recordFailure(
    tx: DbTransaction,
    deliveryId: string,
    failure: { attempts: number; error: string; dead: boolean; at: Date },
  ): Promise<void> {
    await tx
      .update(emailDeliveries)
      .set({
        attempts: failure.attempts,
        lastError: failure.error,
        ...(failure.dead ? { status: 'failed' as const, failedAt: failure.at } : {}),
      })
      .where(and(eq(emailDeliveries.id, deliveryId), ne(emailDeliveries.status, 'sent')));
  }

  /** Back into the queue for a new round; only a failed or discarded send can go. */
  async requeue(tx: DbTransaction, deliveryIds: readonly string[]): Promise<EmailDelivery[]> {
    if (deliveryIds.length === 0) {
      return [];
    }
    return tx
      .update(emailDeliveries)
      .set({ status: 'queued', attempts: 0, lastError: null, failedAt: null })
      .where(
        and(
          inArray(emailDeliveries.id, [...deliveryIds]),
          inArray(emailDeliveries.status, ['failed', 'discarded']),
        ),
      )
      .returning();
  }

  async discard(tx: DbTransaction, deliveryId: string): Promise<boolean> {
    const rows = await tx
      .update(emailDeliveries)
      .set({ status: 'discarded' })
      .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.status, 'failed')))
      .returning({ id: emailDeliveries.id });
    return rows.length === 1;
  }

  /** M14-26. A queued send that must not go (its ticket became spam) is discarded unsent. */
  async discardQueued(tx: DbTransaction, deliveryId: string): Promise<void> {
    await tx
      .update(emailDeliveries)
      .set({ status: 'discarded' })
      .where(and(eq(emailDeliveries.id, deliveryId), eq(emailDeliveries.status, 'queued')));
  }

  async failedIds(tx: DbTransaction): Promise<string[]> {
    const rows = await tx
      .select({ id: emailDeliveries.id })
      .from(emailDeliveries)
      .where(eq(emailDeliveries.status, 'failed'));
    return rows.map((row) => row.id);
  }

  async failedSends(tx: DbTransaction) {
    const rows = await tx
      .select({
        id: emailDeliveries.id,
        recipient: emailDeliveries.toAddress,
        ticketId: emailDeliveries.ticketId,
        prefix: tickets.prefix,
        number: tickets.number,
        lastError: emailDeliveries.lastError,
        attempts: emailDeliveries.attempts,
        failedAt: emailDeliveries.failedAt,
        updatedAt: emailDeliveries.updatedAt,
      })
      .from(emailDeliveries)
      .innerJoin(tickets, eq(tickets.id, emailDeliveries.ticketId))
      .where(eq(emailDeliveries.status, 'failed'))
      .orderBy(desc(emailDeliveries.failedAt))
      .limit(200);

    return rows.map(({ prefix, number, failedAt, updatedAt, ...row }) => ({
      ...row,
      ticketReference: reference(prefix, number),
      failedAt: failedAt ?? updatedAt,
    }));
  }

  /** M2-06's per-sender cap: auto-replies sent or queued to this address since `since`. */
  async autoRepliesTo(tx: DbTransaction, address: string, since: Date): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(emailDeliveries)
      .where(
        and(
          sql`lower(${emailDeliveries.toAddress}) = ${address.toLowerCase()}`,
          ne(emailDeliveries.kind, 'reply'),
          gte(emailDeliveries.createdAt, since),
        ),
      );
    return row?.count ?? 0;
  }

  // ---------------------------------------------------------------- sending

  async sendFacts(tx: DbTransaction, delivery: EmailDelivery): Promise<SendFacts | undefined> {
    const [ticket] = await tx
      .select({
        id: tickets.id,
        prefix: tickets.prefix,
        number: tickets.number,
        subject: tickets.subject,
        contactId: tickets.contactId,
        brandName: brands.name,
        departmentName: departments.name,
        departmentNameAr: departments.nameAr,
        contactName: contacts.name,
        isSpam: ticketStatuses.isSpam,
      })
      .from(tickets)
      .innerJoin(brands, eq(brands.id, tickets.brandId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .leftJoin(contacts, eq(contacts.id, tickets.contactId))
      .where(eq(tickets.id, delivery.ticketId))
      .limit(1);
    if (ticket === undefined) {
      return undefined;
    }

    const message =
      delivery.ticketMessageId === null
        ? undefined
        : (
            await tx
              .select({
                bodyHtml: ticketMessages.bodyHtml,
                bodyText: ticketMessages.bodyText,
                authorId: ticketMessages.authorId,
                authorType: ticketMessages.authorType,
                replyToMessageId: ticketMessages.replyToMessageId,
              })
              .from(ticketMessages)
              .where(eq(ticketMessages.id, delivery.ticketMessageId))
              .limit(1)
          )[0];

    const author =
      message?.authorType === 'staff' && message.authorId !== null
        ? (
            await tx
              .select(authorColumns)
              .from(users)
              .where(eq(users.id, message.authorId))
              .limit(1)
          )[0]
        : undefined;

    const replyTarget =
      delivery.kind === 'reply' && message?.replyToMessageId != null
        ? await this.#replyTarget(tx, delivery.ticketId, message.replyToMessageId)
        : null;

    return {
      ticket: {
        id: ticket.id,
        reference: reference(ticket.prefix, ticket.number),
        subject: ticket.subject,
        contactId: ticket.contactId,
      },
      brandName: ticket.brandName,
      departmentName:
        delivery.locale === 'ar' && ticket.departmentNameAr !== null
          ? ticket.departmentNameAr
          : ticket.departmentName,
      contactName: ticket.contactName,
      isSpam: ticket.isSpam,
      message: message ?? null,
      author: author ?? null,
      replyTarget,
      transcript: delivery.kind === 'transcript' ? await this.#transcript(tx, ticket.id) : [],
    };
  }

  async #transcript(tx: DbTransaction, ticketId: string): Promise<TranscriptLine[]> {
    const rows = await tx
      .select({
        authorType: ticketMessages.authorType,
        bodyText: ticketMessages.bodyText,
        createdAt: ticketMessages.createdAt,
        staffName: users.name,
        staffPublicName: users.publicName,
      })
      .from(ticketMessages)
      .leftJoin(
        users,
        and(
          eq(ticketMessages.authorType, 'staff'),
          sql`${users.id}::text = ${ticketMessages.authorId}`,
        ),
      )
      .where(
        and(eq(ticketMessages.ticketId, ticketId), inArray(ticketMessages.kind, ['public', 'ai'])),
      )
      .orderBy(asc(ticketMessages.seq));

    return rows.map((row) => ({
      from: row.authorType === 'contact' ? 'visitor' : 'agent',
      agentName:
        row.authorType === 'staff' && row.staffName !== null
          ? publicNameOf({ fullName: row.staffName, publicName: row.staffPublicName }) || null
          : null,
      text: row.bodyText,
      at: row.createdAt,
    }));
  }

  /**
   * M14-31. The stored message a reply was aimed at, if it is still a customer
   * email of this ticket. Every id read from it is checked to be one well-formed
   * `msg-id` before it can reach a header.
   */
  async #replyTarget(
    tx: DbTransaction,
    ticketId: string,
    messageId: string,
  ): Promise<ReplyTarget | null> {
    const [row] = await tx
      .select({
        externalMessageId: ticketMessages.externalMessageId,
        bodyText: ticketMessages.bodyText,
        email: ticketMessages.email,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.id, messageId),
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.kind, 'public'),
          eq(ticketMessages.authorType, 'contact'),
          eq(ticketMessages.channel, 'email'),
        ),
      )
      .limit(1);
    if (row === undefined) {
      return null;
    }

    const meta = emailMessageMetaSchema.safeParse(row.email);
    const arrived = meta.success ? meta.data : undefined;
    const sentAt = arrived?.date == null ? row.createdAt : new Date(arrived.date);

    return {
      messageId: safeMessageId(row.externalMessageId),
      references: (arrived?.references ?? []).flatMap((id) => safeMessageId(id) ?? []),
      senderName: arrived?.from.name?.trim() || null,
      sentAt: Number.isNaN(sentAt.getTime()) ? row.createdAt : sentAt,
      arrivedAt: row.createdAt,
      text: row.bodyText,
    };
  }

  /**
   * The ids a reply threads under (RFC 5322 §3.6.4): the customer's last
   * message before it as `In-Reply-To`, and every id of the thread so far as
   * `References`, oldest first and bounded, so a client files the reply where
   * the customer's copy of the conversation already is.
   *
   * M14-31: a reply aimed at one email threads to that email instead: its id
   * is `In-Reply-To`, and `References` is that email's own chain (what arrived
   * with it, else the thread before it) plus its id. A target with no usable
   * `Message-ID` leaves the reply threaded as an ordinary one.
   */
  async threadIds(
    tx: DbTransaction,
    delivery: EmailDelivery,
    target?: ReplyTarget | null,
  ): Promise<{ inReplyTo: string | undefined; references: string[] }> {
    if (target?.messageId === undefined) {
      return this.#chain(tx, delivery.ticketId, delivery.createdAt);
    }

    const before =
      target.references.length > 0
        ? target.references
        : // Stored ids of other messages are checked like the target's own before they are
          // copied into a header we write.
          (await this.#chain(tx, delivery.ticketId, target.arrivedAt)).references.flatMap(
            (id) => safeMessageId(id) ?? [],
          );

    return {
      inReplyTo: target.messageId,
      references: [...new Set([...before, target.messageId])].slice(-REFERENCES_MAX),
    };
  }

  async #chain(
    tx: DbTransaction,
    ticketId: string,
    before: Date,
  ): Promise<{ inReplyTo: string | undefined; references: string[] }> {
    const inbound = await tx
      .select({ id: ticketMessages.externalMessageId })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, ticketId),
          eq(ticketMessages.channel, 'email'),
          eq(ticketMessages.kind, 'public'),
          eq(ticketMessages.authorType, 'contact'),
          isNotNull(ticketMessages.externalMessageId),
          lt(ticketMessages.createdAt, before),
        ),
      )
      .orderBy(desc(ticketMessages.seq))
      .limit(10);
    const ours = await tx
      .select({ id: emailDeliveries.messageId, createdAt: emailDeliveries.createdAt })
      .from(emailDeliveries)
      .where(
        and(
          eq(emailDeliveries.ticketId, ticketId),
          eq(emailDeliveries.status, 'sent'),
          lt(emailDeliveries.createdAt, before),
        ),
      )
      .orderBy(desc(emailDeliveries.createdAt))
      .limit(10);

    const last = inbound[0]?.id ?? undefined;
    const references = [
      ...new Set([
        ...inbound.map((row) => row.id).filter((id): id is string => id !== null),
        ...ours.map((row) => row.id),
      ]),
    ].reverse();

    return { inReplyTo: last ?? ours[0]?.id, references };
  }
}
