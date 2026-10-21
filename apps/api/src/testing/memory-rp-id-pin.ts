import type { DbTransaction } from '@helpdock/db';
import type { PinnedRpId, RpIdPin } from '../auth/webauthn/rp-id-pin.js';

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

  isLocked(): boolean {
    return this.locked;
  }

  async moveTo<T>(
    rpId: string,
    _actorId: string,
    within: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await within({} as DbTransaction);
    this.pinned = { rpId, pinnedAt: new Date() };
    return result;
  }

  pinIfUnset(rpId: string): Promise<PinnedRpId> {
    this.pinned ??= { rpId, pinnedAt: new Date() };
    return Promise.resolve(this.pinned);
  }
}
