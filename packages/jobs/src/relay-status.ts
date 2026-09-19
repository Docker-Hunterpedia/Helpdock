import { z } from 'zod';

/**
 * Where the outbox relay says how it is doing, for `/metrics` and the admin
 * System page (ARCHITECTURE §14).
 *
 * The relay reports rather than being asked, because it is the one component
 * that may look at every brand's `outbox` at once: publishing runs one brand at
 * a time under a system context (DOMAIN-RULES §1.4), and the discovery read
 * that precedes it is the deliberate multi-brand statement documented in
 * `relay.ts`. An api replica answering "how big is the backlog?" would have to
 * widen its own tenant context to find out, and an install-scope request cannot
 * see another brand's rows at all. So the relay writes what it already knows.
 *
 * Redis rather than Postgres: this is a heartbeat, rewritten every cycle, and
 * losing it costs an operator one line on a page. Nothing durable lives only in
 * Redis (DOMAIN-RULES §10).
 */

export const RELAY_STATUS_KEY = 'hd:relay:last';

/**
 * Long enough that a relay polling every 500 ms always has a live key, short
 * enough that one which died is not still reported as healthy. The reader also
 * checks the age, so the expiry is the backstop rather than the rule.
 */
export const RELAY_STATUS_TTL_SECONDS = 300;

export const relayStatusSchema = z.object({
  /** When the cycle finished. */
  at: z.iso.datetime(),
  /** How long the cycle took, discovery included. */
  durationMs: z.number().nonnegative(),
  /** Unpublished rows across every brand the relay owns, as the cycle started. */
  pending: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  /** Brands that had unpublished rows. */
  brands: z.number().int().nonnegative(),
  /** Brands another replica was already publishing. */
  skipped: z.number().int().nonnegative(),
  /** Brands whose batch threw. Their rows are retried next cycle. */
  failed: z.number().int().nonnegative(),
});

export type RelayStatus = z.infer<typeof relayStatusSchema>;

/**
 * The two Redis calls the status needs. Declaring them rather than importing
 * `Redis` keeps the shape usable by anything that speaks Redis, and an `ioredis`
 * client satisfies it unchanged.
 */
export interface RelayStatusStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export const writeRelayStatus = async (
  store: RelayStatusStore,
  status: RelayStatus,
): Promise<void> => {
  await store.set(
    RELAY_STATUS_KEY,
    JSON.stringify(relayStatusSchema.parse(status)),
    'EX',
    RELAY_STATUS_TTL_SECONDS,
  );
};

/**
 * The last cycle a relay reported, or `null` when none has. Content that does
 * not parse is `null` too: this feeds a status panel and a metrics scrape, and
 * neither may fail because something else wrote to the key.
 */
export const readRelayStatus = async (store: RelayStatusStore): Promise<RelayStatus | null> => {
  const raw = await store.get(RELAY_STATUS_KEY);
  if (raw === null) {
    return null;
  }

  try {
    const parsed = relayStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
