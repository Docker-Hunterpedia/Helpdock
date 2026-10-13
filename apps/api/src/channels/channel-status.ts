import { type Db, type MetaAccount, mailboxes, metaAccounts, telegramBots } from '@helpdock/db';
import {
  type ChannelStatus,
  type ComponentStatus,
  mailboxHealth,
  metaAccountHealth,
  telegramBotHealth,
} from '@helpdock/schemas';
import { asc } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * The System page's Channels card (REQUIREMENTS §4.10: "channel connection
 * status"): every mailbox, Telegram bot and Meta account of every brand, each
 * with the health word its own Channels list shows.
 *
 * An install-scope read, as the page is: it runs as the system principal over
 * every brand and reads the configuration tables and nothing else — never a
 * ticket, a contact or a secret (a Meta account's token column is not selected
 * into the answer).
 */

const STATUS_BY_HEALTH: Readonly<Record<string, ComponentStatus>> = {
  healthy: 'ok',
  waiting: 'ok',
  behind: 'warning',
  failing: 'error',
};

/** What the card calls an account: the number, the Page's name, the `@handle`. */
const metaName = (account: MetaAccount): string => {
  switch (account.platform) {
    case 'whatsapp':
      return account.displayPhone ?? account.displayName;
    case 'messenger':
      return account.displayName;
    case 'instagram':
      return account.username === null ? account.displayName : `@${account.username}`;
  }
};

/** The failure itself when the row knows which, otherwise the health word. */
const metaDetail = (account: MetaAccount, health: string): string =>
  account.status === 'token_expired'
    ? 'token expired'
    : account.status === 'unsubscribed'
      ? 'unsubscribed'
      : health;

export const readChannelStatuses = async (db: Db, now: Date): Promise<ChannelStatus[]> => {
  const checkedAt = now.toISOString();
  const boxes = await withAllBrands(db, 'system.channels', (tx) =>
    tx.select().from(mailboxes).orderBy(asc(mailboxes.address)),
  );
  const bots = await withAllBrands(db, 'system.channels', (tx) =>
    tx.select().from(telegramBots).orderBy(asc(telegramBots.username)),
  );
  const accounts = await withAllBrands(db, 'system.channels', (tx) =>
    tx
      .select()
      .from(metaAccounts)
      .orderBy(asc(metaAccounts.platform), asc(metaAccounts.displayName)),
  );

  return [
    ...boxes.map((mailbox): ChannelStatus => {
      const health = mailboxHealth(mailbox, now);
      return {
        id: mailbox.id,
        name: mailbox.address,
        kind: 'email',
        status: STATUS_BY_HEALTH[health] ?? 'warning',
        detail: health,
        checkedAt,
      };
    }),
    ...bots.map((bot): ChannelStatus => {
      const health = telegramBotHealth(bot);
      return {
        id: bot.id,
        name: `@${bot.username}`,
        kind: 'telegram',
        status: STATUS_BY_HEALTH[health] ?? 'warning',
        detail: health,
        checkedAt,
      };
    }),
    ...accounts.map((account): ChannelStatus => {
      const health = metaAccountHealth(account);
      return {
        id: account.id,
        name: metaName(account),
        kind: account.platform,
        status: STATUS_BY_HEALTH[health] ?? 'warning',
        detail: metaDetail(account, health),
        checkedAt,
      };
    }),
  ];
};
