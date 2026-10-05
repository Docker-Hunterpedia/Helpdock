import { brands, type Db, mailboxes, withTenant } from '@helpdock/db';
import {
  type ChannelStatus,
  type ComponentStatus,
  type MailboxHealthState,
  mailboxHealth,
} from '@helpdock/schemas';
import { asc, eq } from 'drizzle-orm';

/**
 * The System page's channel list (M8-05): every connected channel of every
 * active brand, with a state an operator can read at a glance.
 *
 * **The hook for more channels.** Each kind of channel is a
 * {@link ChannelStatusSource}; the page lists what all of them return, in the
 * order they are given. Mailboxes are the one source today. Telegram bots
 * (M6) add a source of their own to `CHANNEL_STATUS_SOURCES` in
 * `observability.module.ts`; nothing else changes.
 */

export interface ChannelStatusSource {
  statuses(db: Db, now: Date): Promise<readonly ChannelStatus[]>;
}

export const CHANNEL_STATUS_SOURCES = Symbol('helpdock.channel-status-sources');

const STATUS_BY_HEALTH: Readonly<Record<MailboxHealthState, ComponentStatus>> = {
  healthy: 'ok',
  behind: 'warning',
  waiting: 'warning',
  failing: 'error',
};

/** The principal the cross-brand read is recorded under. */
const PRINCIPAL = 'system.channel-status';

/**
 * Mailboxes, read in a system transaction over every active brand: `brands`
 * is global, so its ids need no context, and the context is then set to
 * exactly those ids, as ARCHITECTURE §6 asks of an all-brands path. The row's
 * health is M2's own rule (`mailboxHealth`), so the System page and Channels ›
 * Mailboxes never disagree about a mailbox.
 */
export class MailboxChannelStatus implements ChannelStatusSource {
  async statuses(db: Db, now: Date): Promise<readonly ChannelStatus[]> {
    const active = await db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.status, 'active'));
    if (active.length === 0) {
      return [];
    }
    const brandNames = new Map(active.map((brand) => [brand.id, brand.name]));

    const rows = await withTenant(
      db,
      {
        brandIds: active.map((brand) => brand.id),
        departmentIds: 'all',
        principalType: 'system',
        principalId: PRINCIPAL,
      },
      (tx) => tx.select().from(mailboxes).orderBy(asc(mailboxes.address)),
    );

    return rows.map((mailbox) => {
      const health = mailboxHealth(mailbox, now);
      return {
        id: mailbox.id,
        name: mailbox.address,
        brandName: brandNames.get(mailbox.brandId) ?? '',
        kind: 'email',
        status: STATUS_BY_HEALTH[health],
        detail: health,
        checkedAt: (mailbox.lastPolledAt ?? mailbox.updatedAt).toISOString(),
      };
    });
  }
}

/** Every source's channels, a failing source left out rather than failing the page. */
export const readChannelStatuses = async (
  sources: readonly ChannelStatusSource[],
  db: Db,
  now: Date,
): Promise<ChannelStatus[]> => {
  const settled = await Promise.allSettled(sources.map((source) => source.statuses(db, now)));

  return settled.flatMap((result) => (result.status === 'fulfilled' ? [...result.value] : []));
};
