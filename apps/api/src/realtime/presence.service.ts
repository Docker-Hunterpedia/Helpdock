import {
  brandRoom,
  PRESENCE_REAPER_INTERVAL_MS,
  type PresenceMap,
  type PresenceStatus,
  REALTIME_EVENTS,
  type SettablePresenceStatus,
} from '@helpdock/schemas';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { type IdleAwayPolicy, NoIdleAwayPolicy } from './idle-away.policy.js';
import { type PresenceMembership, PresenceStore } from './presence.store.js';
import { RealtimePublisher } from './publisher.js';
import type { StaffOfflineHook } from './staff-offline.hook.js';
import { IDLE_AWAY_POLICY, STAFF_OFFLINE_HOOK } from './tokens.js';

/**
 * Staff presence (DOMAIN-RULES §12): the store decides *what* is true, this
 * decides *who is told*. Every change is announced to `brand:<id>`, and only
 * the replica that actually changed the state announces it, so two replicas
 * sweeping the same expired socket produce one event rather than two.
 *
 * The reaper is what makes presence survive a replica being killed: nothing
 * runs a disconnect handler in that case, so the liveness keys simply expire
 * and this notices within thirty seconds. That is the sixty-second TTL plus
 * one sweep, comfortably inside the "within 5 seconds" budget §1.4 puts on
 * revocation and well inside the five-minute one exit criterion M0 asks for.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  readonly #listeners = new Set<(brandId: string) => void>();
  readonly #store: PresenceStore;
  readonly #publisher: RealtimePublisher;
  readonly #offline: StaffOfflineHook;
  readonly #logger: Logger;
  readonly #idlePolicy: IdleAwayPolicy;
  #reaper: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PresenceStore) store: PresenceStore,
    @Inject(RealtimePublisher) publisher: RealtimePublisher,
    @Inject(STAFF_OFFLINE_HOOK) offline: StaffOfflineHook,
    @Inject(LOGGER) logger: Logger,
    @Optional() @Inject(IDLE_AWAY_POLICY) idlePolicy: IdleAwayPolicy = new NoIdleAwayPolicy(),
  ) {
    this.#idlePolicy = idlePolicy;
    this.#store = store;
    this.#publisher = publisher;
    this.#offline = offline;
    this.#logger = logger;
  }

  onModuleInit(): void {
    this.#reaper = setInterval(() => {
      void this.sweep();
    }, PRESENCE_REAPER_INTERVAL_MS);
    // The sweep must not be the reason the process stays alive; the server is.
    this.#reaper.unref();
  }

  onModuleDestroy(): void {
    if (this.#reaper !== null) {
      clearInterval(this.#reaper);
      this.#reaper = null;
    }
  }

  async join(membership: PresenceMembership): Promise<PresenceStatus> {
    const { arrived } = await this.#store.join(membership);
    const status = await this.#store.statusOf(membership.brandId, membership.userId);

    if (arrived) {
      this.#announce(membership.brandId, membership.userId, status);
    }

    return status;
  }

  /** Refreshes liveness, and re-announces anyone a sweep had prematurely dropped. */
  async heartbeat(socketId: string, memberships: readonly PresenceMembership[]): Promise<void> {
    const { repaired } = await this.#store.heartbeat(socketId, memberships);
    for (const membership of repaired) {
      this.#announce(
        membership.brandId,
        membership.userId,
        await this.#store.statusOf(membership.brandId, membership.userId),
      );
    }
  }

  async leave(membership: PresenceMembership): Promise<void> {
    const { departed } = await this.#store.leave(membership);
    if (departed) {
      await this.#goneOffline(membership.brandId, membership.userId);
    }
  }

  async setStatus(
    membership: Omit<PresenceMembership, 'socketId'>,
    status: SettablePresenceStatus,
  ): Promise<PresenceStatus> {
    const applied = await this.#store.setStatus(membership, status);
    if (!applied) {
      // No socket of theirs is present, so they are offline and a toggle means
      // nothing. Answering honestly is better than pretending it took.
      return 'offline';
    }

    this.#announce(membership.brandId, membership.userId, status);
    return status;
  }

  /**
   * M14-18. Somebody reported activity. Answers their status, and whether this
   * report is the one that ended an idle away (so the admin can say so once).
   * An explicit away stays: only the idle reason is lifted, never a choice.
   */
  async active(
    membership: Omit<PresenceMembership, 'socketId'>,
  ): Promise<{ status: PresenceStatus; idleEnded: boolean }> {
    const { present, idleEnded } = await this.#store.touch(membership);
    if (!present) {
      return { status: 'offline', idleEnded: false };
    }

    const status = await this.#store.statusOf(membership.brandId, membership.userId);
    if (idleEnded) {
      this.#announce(membership.brandId, membership.userId, status);
    }

    return { status, idleEnded: idleEnded && status === 'online' };
  }

  async mapOf(brandId: string): Promise<PresenceMap> {
    return this.#store.map(brandId);
  }

  /**
   * Everyone whose sockets have all expired is offline, and is announced as
   * such; then, per brand, everyone who has been idle past their department's
   * limit is away (M14-18).
   */
  async sweep(): Promise<void> {
    try {
      for (const brandId of await this.#store.brands()) {
        for (const userId of await this.#store.usersIn(brandId)) {
          const { departed } = await this.#store.sweepUser(brandId, userId);
          if (departed) {
            await this.#goneOffline(brandId, userId);
          }
        }
        await this.#sweepIdle(brandId);
      }
    } catch (error) {
      // A sweep that throws must not kill the interval: Redis comes back, and
      // the next sweep thirty seconds later finds the same expired keys.
      this.#logger.error({ err: error }, 'The presence sweep failed');
    }
  }

  /**
   * Marks away whoever has reported nothing for their limit, and lifts the mark
   * from whoever's department stopped asking for it. A failing policy read
   * leaves every mark as it was: guessing "nobody is limited" would wake the
   * whole brand up, and guessing "everybody is" would put them to sleep.
   */
  async #sweepIdle(brandId: string): Promise<void> {
    let limits: ReadonlyMap<string, number>;
    try {
      limits = await this.#idlePolicy.limitsFor(brandId);
    } catch (error) {
      this.#logger.error({ err: error, brandId }, 'The idle-away limits could not be read');
      return;
    }

    for (const userId of await this.#store.usersIn(brandId)) {
      const minutes = limits.get(userId);
      if (minutes === undefined) {
        continue;
      }

      if (await this.#store.markIdleIfStale(brandId, userId, minutes * 60_000)) {
        this.#announce(brandId, userId, await this.#store.statusOf(brandId, userId));
      }
    }

    for (const userId of await this.#store.idleUsers(brandId)) {
      if (!limits.has(userId) && (await this.#store.releaseIdle(brandId, userId))) {
        this.#announce(brandId, userId, await this.#store.statusOf(brandId, userId));
      }
    }
  }

  async #goneOffline(brandId: string, userId: string): Promise<void> {
    const since = new Date();
    this.#announce(brandId, userId, 'offline');

    try {
      await this.#offline.onStaffOffline(userId, brandId, since);
    } catch (error) {
      this.#logger.error({ err: error, userId, brandId }, 'The staff-offline hook failed');
    }
  }

  /**
   * M4-04. Tells `listener` whenever somebody's presence in a brand changes,
   * on the replica that saw the change. The widget uses it to tell visitors
   * whether anybody is there. Returns the unsubscribe.
   */
  onChange(listener: (brandId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #announce(brandId: string, userId: string, status: PresenceStatus): void {
    this.#publisher.emitToRoom(brandRoom(brandId), REALTIME_EVENTS.presenceChanged, {
      userId,
      brandId,
      status,
    });
    for (const listener of this.#listeners) {
      listener(brandId);
    }
  }
}
