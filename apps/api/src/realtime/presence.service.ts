import {
  brandRoom,
  PRESENCE_REAPER_INTERVAL_MS,
  type PresenceMap,
  type PresenceStatus,
  REALTIME_EVENTS,
  type SettablePresenceStatus,
} from '@helpdock/schemas';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { type PresenceMembership, PresenceStore } from './presence.store.js';
import { RealtimePublisher } from './publisher.js';
import type { StaffOfflineHook } from './staff-offline.hook.js';
import { STAFF_OFFLINE_HOOK } from './tokens.js';

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
  readonly #store: PresenceStore;
  readonly #publisher: RealtimePublisher;
  readonly #offline: StaffOfflineHook;
  readonly #logger: Logger;
  #reaper: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PresenceStore) store: PresenceStore,
    @Inject(RealtimePublisher) publisher: RealtimePublisher,
    @Inject(STAFF_OFFLINE_HOOK) offline: StaffOfflineHook,
    @Inject(LOGGER) logger: Logger,
  ) {
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

  async mapOf(brandId: string): Promise<PresenceMap> {
    return this.#store.map(brandId);
  }

  /** Everyone whose sockets have all expired is offline, and is announced as such. */
  async sweep(): Promise<void> {
    try {
      for (const brandId of await this.#store.brands()) {
        for (const userId of await this.#store.usersIn(brandId)) {
          const { departed } = await this.#store.sweepUser(brandId, userId);
          if (departed) {
            await this.#goneOffline(brandId, userId);
          }
        }
      }
    } catch (error) {
      // A sweep that throws must not kill the interval: Redis comes back, and
      // the next sweep thirty seconds later finds the same expired keys.
      this.#logger.error({ err: error }, 'The presence sweep failed');
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

  #announce(brandId: string, userId: string, status: PresenceStatus): void {
    this.#publisher.emitToRoom(brandRoom(brandId), REALTIME_EVENTS.presenceChanged, {
      userId,
      brandId,
      status,
    });
  }
}
