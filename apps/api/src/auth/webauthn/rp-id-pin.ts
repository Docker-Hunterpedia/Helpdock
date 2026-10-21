import type { Settings } from '@helpdock/config';
import {
  auditLog,
  brands,
  type Db,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  settings as settingsTable,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { and, eq, sql } from 'drizzle-orm';
import { AUTH_SYSTEM_PRINCIPAL } from '../staff.repository.js';

const KEY = 'auth.webauthn.rpId';

/** The pin is not the host a move began from: another move, or a pin, got there first. */
export class RpIdPinChangedError extends Error {
  constructor() {
    super(`${KEY} changed while it was being moved`);
    this.name = 'RpIdPinChangedError';
  }
}
/** The JSON encoding of the empty default, which means "not pinned yet". */
const UNPINNED = JSON.stringify('');

export interface PinnedRpId {
  readonly rpId: string;
  /** When the first registration pinned it; null when `HD_AUTH_WEBAUTHN_RP_ID` set it. */
  readonly pinnedAt: Date | null;
}

/** What the passkey ceremonies need from the pin; {@link RpIdPinStore} is the real one. */
export interface RpIdPin {
  read(): Promise<PinnedRpId | null>;
  pinIfUnset(rpId: string): Promise<PinnedRpId>;
  /** True when `HD_AUTH_WEBAUTHN_RP_ID` pins it, so nothing here may change it. */
  isLocked(): boolean;
  /**
   * Moves the pin from `from` to `to` in one transaction with `within`, which
   * removes the passkeys made for `from`, audits and notifies: the pin must never
   * move while they stay, and none of it may happen without the others. Refuses
   * with {@link RpIdPinChangedError} when the pin is no longer `from`.
   */
  moveTo<T>(
    move: { readonly from: string; readonly to: string; readonly actorId: string },
    within: (tx: DbTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * `auth.webauthn.rpId`: the RP ID every passkey on this install was made
 * for, written by the first successful registration and compared by every
 * ceremony (ADR 0050). A passkey only ever works on the RP ID it was registered under,
 * so if `APP_URL` moves to another host the stored value is what tells the
 * api that the passkeys it holds no longer can, instead of every ceremony
 * failing in the browser with nothing said.
 *
 * It reads and writes the `settings` row directly, not through `Settings`:
 * the first write has to be "insert unless present" in one statement, so two
 * replicas pinning at once agree on one value, and `Settings` caches what it
 * read, which would hide a pin another replica made a moment ago.
 */
export class RpIdPinStore implements RpIdPin {
  readonly #db: Db;
  readonly #settings: Settings;

  constructor({ db, settings }: { readonly db: Db; readonly settings: Settings }) {
    this.#db = db;
    this.#settings = settings;
  }

  isLocked(): boolean {
    return this.#settings.isLockedByEnv(KEY);
  }

  async moveTo<T>(
    { from, to, actorId }: { readonly from: string; readonly to: string; readonly actorId: string },
    within: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.isLocked()) {
      throw new Error(`${KEY} is pinned by the environment and cannot be moved`);
    }

    // Notices go through the outbox of each holder's brand, so the transaction reaches them all.
    const activeBrands = await this.#db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.status, 'active'));

    return withTenant(
      this.#db,
      {
        brandIds: [INSTALL_SCOPE_BRAND_ID, ...activeBrands.map((brand) => brand.id)],
        departmentIds: 'all',
        principalType: 'system',
        principalId: AUTH_SYSTEM_PRINCIPAL,
      },
      async (tx) => {
        // Only while it still holds the old host; a second move waits on this row and then finds it changed.
        const moved = await tx
          .update(settingsTable)
          .set({ value: JSON.stringify(to), updatedBy: actorId, updatedAt: sql`now()` })
          .where(
            and(
              eq(settingsTable.key, KEY),
              eq(settingsTable.brandId, INSTALL_SCOPE_BRAND_ID),
              eq(settingsTable.value, JSON.stringify(from)),
            ),
          )
          .returning({ key: settingsTable.key });
        if (moved.length === 0) {
          throw new RpIdPinChangedError();
        }
        return within(tx);
      },
    );
  }

  /** The pinned RP ID, or null before the first registration. */
  async read(): Promise<PinnedRpId | null> {
    if (this.#settings.isLockedByEnv(KEY)) {
      return { rpId: await this.#settings.get(KEY), pinnedAt: null };
    }

    const [row] = await withSystem(this.#db, INSTALL_SCOPE_BRAND_ID, (tx) =>
      tx
        .select({ value: settingsTable.value, updatedAt: settingsTable.updatedAt })
        .from(settingsTable)
        .where(and(eq(settingsTable.brandId, INSTALL_SCOPE_BRAND_ID), eq(settingsTable.key, KEY))),
    );
    if (row === undefined) {
      return null;
    }

    const rpId: unknown = JSON.parse(row.value);
    return typeof rpId === 'string' && rpId !== '' ? { rpId, pinnedAt: row.updatedAt } : null;
  }

  /**
   * Pins `rpId` unless something is pinned already, and answers whatever is
   * pinned afterwards: the caller compares it with the RP ID it wanted, and a
   * replica that lost the race to another host learns so here.
   */
  async pinIfUnset(rpId: string): Promise<PinnedRpId> {
    if (!this.#settings.isLockedByEnv(KEY)) {
      await withSystem(this.#db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
        const pinned = await tx
          .insert(settingsTable)
          .values({
            key: KEY,
            brandId: INSTALL_SCOPE_BRAND_ID,
            value: JSON.stringify(rpId),
            updatedBy: AUTH_SYSTEM_PRINCIPAL,
          })
          .onConflictDoUpdate({
            target: [settingsTable.key, settingsTable.brandId],
            set: { value: JSON.stringify(rpId), updatedAt: sql`now()` },
            setWhere: eq(settingsTable.value, UNPINNED),
          })
          .returning({ key: settingsTable.key });

        if (pinned.length > 0) {
          await tx.insert(auditLog).values({
            brandId: INSTALL_SCOPE_BRAND_ID,
            actorType: 'system',
            actorId: AUTH_SYSTEM_PRINCIPAL,
            action: 'auth.passkey.rp_pinned',
            targetType: 'setting',
            targetId: KEY,
            meta: { rpId },
          });
        }
      });
    }

    const pinned = await this.read();
    /* c8 ignore next 3 -- the statement above leaves a non-empty row behind, or the env pins one. */
    if (pinned === null) {
      throw new Error('auth.webauthn.rpId is still unset after pinning it');
    }
    return pinned;
  }
}
