import type { DbTransaction } from '@helpdock/db';
import { type PinnedRpId, type RpIdPin, RpIdPinChangedError } from '../auth/webauthn/rp-id-pin.js';

/** `auth.webauthn.rpId` without a database, for unit tests of the passkey ceremonies. */
export class MemoryRpIdPin implements RpIdPin {
  pinned: PinnedRpId | null;

  constructor(rpId?: string) {
    this.pinned = rpId === undefined ? null : { rpId, pinnedAt: new Date() };
  }

  read(): Promise<PinnedRpId | null> {
    return Promise.resolve(this.pinned);
  }

  locked = false;
  /** Rows a completed move wrote through its transaction. */
  audited: Record<string, unknown>[] = [];

  isLocked(): boolean {
    return this.locked;
  }

  async moveTo<T>(
    { from, to }: { from: string; to: string; actorId: string },
    within: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.pinned?.rpId !== from) {
      throw new RpIdPinChangedError();
    }
    const written: Record<string, unknown>[] = [];
    // Only what the move writes through its transaction: the audit row.
    const tx = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          written.push(row);
          return Promise.resolve();
        },
      }),
    } as unknown as DbTransaction;
    const result = await within(tx);
    this.audited.push(...written);
    this.pinned = { rpId: to, pinnedAt: new Date() };
    return result;
  }

  pinIfUnset(rpId: string): Promise<PinnedRpId> {
    this.pinned ??= { rpId, pinnedAt: new Date() };
    return Promise.resolve(this.pinned);
  }
}
