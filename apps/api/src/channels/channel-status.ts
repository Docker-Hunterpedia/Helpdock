import { type Db, mailboxes, telegramBots } from '@helpdock/db';
import {
  type ChannelStatus,
  type ComponentStatus,
  mailboxHealth,
  telegramBotHealth,
} from '@helpdock/schemas';
import { asc } from 'drizzle-orm';
import { withAllBrands } from '../tenant/all-brands.js';

/**
 * The System page's Channels card (REQUIREMENTS §4.10: "channel connection
 * status"): every mailbox and Telegram bot of every brand, each with the
 * health word its own Channels list shows.
 *
 * An install-scope read, as the page is: it runs as the system principal over
 * every brand and reads the two configuration tables and nothing else — never
 * a ticket, a contact or a secret.
 */

const STATUS_BY_HEALTH: Readonly<Record<string, ComponentStatus>> = {
  healthy: 'ok',
  waiting: 'ok',
  behind: 'warning',
  failing: 'error',
};

export const readChannelStatuses = async (db: Db, now: Date): Promise<ChannelStatus[]> => {
  const checkedAt = now.toISOString();
  const boxes = await withAllBrands(db, 'system.channels', (tx) =>
    tx.select().from(mailboxes).orderBy(asc(mailboxes.address)),
  );
  const bots = await withAllBrands(db, 'system.channels', (tx) =>
    tx.select().from(telegramBots).orderBy(asc(telegramBots.username)),
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
  ];
};
