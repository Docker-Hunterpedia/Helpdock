import { Injectable } from '@nestjs/common';
import type { StaffSocket } from './socket.js';
import { userIdOf } from './socket.js';

/**
 * The sockets this replica is holding, indexed by the person they belong to.
 *
 * It exists for one sentence in DOMAIN-RULES §1.4: "every replica disconnects
 * that principal's sockets within 5 seconds". A `principal.revoked` message
 * names a user, and the replica has to find that user's sockets without asking
 * Redis or walking every connection.
 */
@Injectable()
export class SocketRegistry {
  readonly #byUser = new Map<string, Set<StaffSocket>>();

  add(socket: StaffSocket): void {
    const userId = userIdOf(socket.data);
    const sockets = this.#byUser.get(userId) ?? new Set<StaffSocket>();
    sockets.add(socket);
    this.#byUser.set(userId, sockets);
  }

  remove(socket: StaffSocket): void {
    const userId = userIdOf(socket.data);
    const sockets = this.#byUser.get(userId);
    if (sockets === undefined) {
      return;
    }

    sockets.delete(socket);
    if (sockets.size === 0) {
      this.#byUser.delete(userId);
    }
  }

  /** A copy, so a caller may disconnect while iterating. */
  socketsOf(userId: string): readonly StaffSocket[] {
    return [...(this.#byUser.get(userId) ?? [])];
  }

  size(): number {
    let total = 0;
    for (const sockets of this.#byUser.values()) {
      total += sockets.size;
    }

    return total;
  }
}
