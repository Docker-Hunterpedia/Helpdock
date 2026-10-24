import { customFieldDefs, type DbTransaction } from '@helpdock/db';
import { missingRequiredToClose, type RequiredToCloseRule } from '@helpdock/schemas';
import { and, eq, inArray } from 'drizzle-orm';
import { TicketLifecycleFailure } from './lifecycle/lifecycle-failure.js';

/**
 * M14-17. The fields a brand will not let a person close a ticket without.
 *
 * One question, three kinds of close, one rule: a close **by a person** — an
 * agent in the admin, or an API key acting for one (owner decision D-30) — is
 * refused with `fields-required-to-close` naming the keys that are still
 * empty, while a close **by the system** — a rule, a time-based rule, a merge,
 * a mark as spam — goes through and records `closedWithout` in its activity
 * row instead, because a rule that silently stops closing tickets is worse
 * than a gap the log can show. The bulk edit closes through the very method a
 * single edit uses, so its preview reports the refusal per ticket with the
 * same code and no second spelling of the rule exists.
 *
 * The read is not filtered by brand: the transaction carries `app.brand_ids`
 * and the policy on `custom_field_defs` applies it, as to every other query.
 */
export const requiredToCloseRules = async (tx: DbTransaction): Promise<RequiredToCloseRule[]> => {
  const rows = await tx
    .select({
      key: customFieldDefs.key,
      type: customFieldDefs.type,
      requiredToClose: customFieldDefs.requiredToClose,
    })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.target, 'ticket'));

  return rows;
};

/**
 * The ticket's empty required-to-close keys, in definition order. `custom` is
 * the values the close would leave behind — a request that patches fields and
 * closes in one body is judged on what it wrote, not on what was stored.
 */
export const missingRequiredToCloseKeys = async (
  tx: DbTransaction,
  custom: Record<string, unknown> | null | undefined,
): Promise<string[]> => missingRequiredToClose(await requiredToCloseRules(tx), custom);

/**
 * The refusal for a close that would leave a required-to-close field empty.
 * Thrown before anything is written, so a refused close is a request that
 * changed nothing.
 */
export const refuseCloseForMissingFields = async (
  tx: DbTransaction,
  custom: Record<string, unknown> | null | undefined,
): Promise<void> => {
  const missing = await missingRequiredToCloseKeys(tx, custom);
  if (missing.length > 0) {
    throw new TicketLifecycleFailure('fields-required-to-close', missing);
  }
};

/** The labels of the keys a refusal named, in the order it named them, for a screen that cannot look them up. */
export const labelsOfFields = async (
  tx: DbTransaction,
  keys: readonly string[],
): Promise<{ key: string; label: string; labelAr: string | null }[]> => {
  if (keys.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      key: customFieldDefs.key,
      label: customFieldDefs.label,
      labelAr: customFieldDefs.labelAr,
    })
    .from(customFieldDefs)
    .where(and(eq(customFieldDefs.target, 'ticket'), inArray(customFieldDefs.key, [...keys])));

  return [...rows].sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
};
