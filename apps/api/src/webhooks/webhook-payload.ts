import {
  csatResponses,
  type DbTransaction,
  hcArticles,
  hcArticleVersions,
  ticketMessages,
} from '@helpdock/db';
import type { WebhookEvent } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { readV1Contact } from '../api-v1/v1-contact-view.js';
import { tagsOfTicket } from '../ticketing/ticket-tags.js';
import { toTicket, toTicketMessage } from '../tickets/ticket-view.js';
import { TicketRepository } from '../tickets/tickets.repository.js';

/**
 * The `data` of a delivery: what the event is about, read in the transaction
 * that creates the delivery and frozen into its row (M8-03). An outbox payload
 * carries ids only; a receiver wants the thing.
 *
 * `undefined` means there is nothing to send — the ticket was deleted, the
 * reply was a note — and no delivery is created.
 */

const ticketRef = z.object({ ticketId: z.uuid() });
const replyRef = ticketRef.extend({
  messageId: z.uuid(),
  kind: z.enum(['public', 'note', 'system', 'ai']).optional(),
});
const contactRef = z.object({ contactId: z.uuid() });
const csatRef = z.object({ surveyId: z.uuid() });
const articleRef = z.object({ articleId: z.uuid(), locale: z.enum(['en', 'ar']).nullable() });

const tickets = new TicketRepository();

const ticketData = async (tx: DbTransaction, ticketId: string) => {
  const found = await tickets.findTicket(tx, ticketId);
  return found === undefined
    ? undefined
    : toTicket(found.ticket, found.status, await tagsOfTicket(tx, ticketId));
};

const replyData = async (tx: DbTransaction, payload: Record<string, unknown>) => {
  const { ticketId, messageId, kind } = replyRef.parse(payload);
  // A note never leaves the desk, by webhook or otherwise.
  if (kind === 'note') {
    return undefined;
  }
  const [message] = await tx
    .select()
    .from(ticketMessages)
    .where(eq(ticketMessages.id, messageId))
    .limit(1);
  const ticket = await ticketData(tx, ticketId);
  return message === undefined || message.kind === 'note' || ticket === undefined
    ? undefined
    : { ticket, message: toTicketMessage(message) };
};

const csatData = async (tx: DbTransaction, payload: Record<string, unknown>) => {
  const { surveyId } = csatRef.parse(payload);
  const [survey] = await tx
    .select()
    .from(csatResponses)
    .where(eq(csatResponses.id, surveyId))
    .limit(1);
  return survey?.rating == null
    ? undefined
    : {
        survey: {
          id: survey.id,
          ticketId: survey.ticketId,
          rating: survey.rating,
          comment: survey.comment,
          ratedAt: survey.ratedAt?.toISOString() ?? null,
        },
      };
};

const articleData = async (tx: DbTransaction, payload: Record<string, unknown>) => {
  const { articleId, locale } = articleRef.parse(payload);
  const rows = await tx
    .select({
      id: hcArticles.id,
      slug: hcArticles.slug,
      locale: hcArticleVersions.locale,
      title: hcArticleVersions.publishedTitle,
      visibility: hcArticleVersions.visibility,
      publishedAt: hcArticleVersions.publishedAt,
    })
    .from(hcArticleVersions)
    .innerJoin(hcArticles, eq(hcArticles.id, hcArticleVersions.articleId))
    .where(
      and(
        eq(hcArticleVersions.articleId, articleId),
        eq(hcArticleVersions.status, 'published'),
        locale === null ? undefined : eq(hcArticleVersions.locale, locale),
      ),
    );
  const [row] = rows;
  return row === undefined
    ? undefined
    : { article: { ...row, publishedAt: row.publishedAt?.toISOString() ?? null } };
};

export const webhookDataFor = async (
  tx: DbTransaction,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> => {
  switch (event) {
    case 'ticket.created':
    case 'ticket.updated':
    case 'ticket.closed': {
      const ticket = await ticketData(tx, ticketRef.parse(payload).ticketId);
      return ticket === undefined ? undefined : { ticket };
    }
    case 'ticket.replied':
      return replyData(tx, payload);
    case 'contact.created': {
      const contact = await readV1Contact(tx, contactRef.parse(payload).contactId);
      return contact === undefined ? undefined : { contact };
    }
    case 'csat.received':
      return csatData(tx, payload);
    case 'article.published':
      return articleData(tx, payload);
  }
};
