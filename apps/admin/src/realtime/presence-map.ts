import type { PresenceChanged, PresenceMap, PresenceStatus } from '@helpdock/schemas';

/**
 * The map a screen renders, and the one rule for keeping it current.
 *
 * Absence is what offline means (the api answers the same way), so an `offline`
 * event removes the entry rather than storing it. That keeps the map the size
 * of the people who are working rather than the size of the brand's roster, and
 * it means a reader needs no special case: anyone not in the map is offline.
 */
export const applyPresenceChange = (map: PresenceMap, change: PresenceChanged): PresenceMap => {
  if (change.status === 'offline') {
    if (!(change.userId in map)) {
      return map;
    }

    const { [change.userId]: _gone, ...rest } = map;
    return rest;
  }

  if (map[change.userId] === change.status) {
    return map;
  }

  return { ...map, [change.userId]: change.status };
};

export const statusOf = (map: PresenceMap, userId: string): PresenceStatus =>
  map[userId] ?? 'offline';
