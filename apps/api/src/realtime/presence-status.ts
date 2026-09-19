import type { PresenceMap, PresenceStatus, SettablePresenceStatus } from '@helpdock/schemas';

/**
 * Presence is `online | away | offline` (DOMAIN-RULES §12), and it is derived,
 * not stored: the sockets decide whether a person is reachable at all and the
 * explicit toggle only chooses between the two reachable states.
 *
 * This is the whole rule, kept in one pure function so both the reader and the
 * reaper answer the same way, and so the answer can be tested without Redis.
 */

export interface DerivePresenceInput {
  /** Whether any of this person's sockets in this brand is still alive. */
  readonly hasLiveSocket: boolean;
  /** What they last set themselves to, if anything. */
  readonly explicit: SettablePresenceStatus | undefined;
}

export const derivePresence = ({
  hasLiveSocket,
  explicit,
}: DerivePresenceInput): PresenceStatus => {
  if (!hasLiveSocket) {
    return 'offline';
  }

  return explicit === 'away' ? 'away' : 'online';
};

/**
 * The map a brand's staff list renders from: everyone with a live socket, at
 * the status they chose. Nobody is listed as `offline` — absence is what
 * offline means, and listing every member of a brand would make the map grow
 * with the roster instead of with who is working.
 */
export const presenceMapOf = (
  present: readonly string[],
  explicit: Readonly<Record<string, string>>,
): PresenceMap => {
  const map: Record<string, PresenceStatus> = {};
  for (const userId of present) {
    map[userId] = derivePresence({
      hasLiveSocket: true,
      explicit: explicit[userId] === 'away' ? 'away' : 'online',
    });
  }

  return map;
};
