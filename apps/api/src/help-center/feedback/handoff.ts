import type { DbTransaction } from '@helpdock/db';
import type { HcLocale } from '@helpdock/schemas';
import { sql } from 'drizzle-orm';
import { type ActivityActor, writeTicketActivity } from '../../tickets/ticket-activity.js';
import { defaultLocaleOf } from '../content-reader.js';
import { readableVersions } from '../visibility.js';

/**
 * "Still need help?" (M5-08, REQUIREMENTS §4.5: "opens widget/form with
 * article context"). The widget conversation or the web form ticket names the
 * article the visitor came from, and the ticket's thread shows it to the
 * agents as one `ticket.source_article` line.
 *
 * The id comes from the visitor's browser, so it is only a claim: it is
 * recorded when it names a published **public** article of this brand, read
 * through the visitor audience in the ticket's own transaction, and silently
 * dropped otherwise — an unknown or internal article must neither fail the
 * visitor's message nor tell them the article exists.
 */

export interface HandoffArticle {
  readonly articleId: string;
  readonly title: string;
  readonly locale: HcLocale;
}

export const handoffArticle = async (
  tx: DbTransaction,
  brandId: string,
  articleId: string,
  locale: HcLocale,
): Promise<HandoffArticle | null> => {
  const defaultLocale = await defaultLocaleOf(tx, brandId);
  const [row] = await tx.execute<{ article_id: string; title: string; locale: HcLocale }>(sql`
    with ${readableVersions('public')}
    select article_id, title, locale
    from readable
    where article_id = ${articleId}::uuid and locale in (${locale}, ${defaultLocale})
    order by (locale = ${locale}) desc
    limit 1`);
  return row === undefined
    ? null
    : { articleId: row.article_id, title: row.title, locale: row.locale };
};

export interface HandoffInput {
  readonly brandId: string;
  readonly ticket: { readonly id: string; readonly departmentId: string };
  readonly actor: ActivityActor;
  readonly articleId: string | undefined;
  /** The visitor's language, which the article's title is read in when it has one. */
  readonly locale: HcLocale;
}

/** Writes the thread line when the article checks out; returns whether it did. */
export const recordHandoff = async (tx: DbTransaction, input: HandoffInput): Promise<boolean> => {
  if (input.articleId === undefined) {
    return false;
  }
  const article = await handoffArticle(tx, input.brandId, input.articleId, input.locale);
  if (article === null) {
    return false;
  }
  await writeTicketActivity(tx, {
    brandId: input.brandId,
    ticketId: input.ticket.id,
    departmentId: input.ticket.departmentId,
    actor: input.actor,
    action: 'ticket.source_article',
    to: { ...article },
  });
  return true;
};
