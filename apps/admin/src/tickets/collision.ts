import { TICKET_VIEWING_TTL_MS } from '@helpdock/schemas';

/**
 * Who else has this ticket open — the collision indicator of the
 * `Admin · ticket view` artboard.
 *
 * **Why it is derived rather than read.** A Socket.IO room is not a membership
 * list: a replica can enumerate the sockets in `ticket:<id>` that it is holding
 * and no more, and "is anybody else looking at this" has to be true across
 * every replica. So the clients say so instead — `ticket:viewing` every
 * {@link TICKET_VIEWING_TTL_MS}/3 — the gateway relays each announcement to the
 * rest of the room after authorising it exactly as the join was, and this is
 * what each client makes of what it hears.
 *
 * Nothing is stored anywhere. A name nobody has repeated inside the window is
 * dropped, which is what makes "closed the tab", "lost the network" and "went
 * to lunch with the ticket open" the same answer: after ninety seconds of
 * silence, they are not looking at it.
 *
 * M1-09 owns the rest of DOMAIN-RULES §2.4. If it grows a server-side register
 * of who holds what, this file is what it replaces.
 */

/** When each person was last heard from, in epoch milliseconds. */
export type ViewerSightings = Readonly<Record<string, number>>;

export const noteViewing = (
  sightings: ViewerSightings,
  userId: string,
  now: number,
): ViewerSightings => ({ ...sightings, [userId]: now });

/**
 * The people other than this one who are still looking, newest sighting first.
 *
 * `selfId` is excluded here rather than at the source: this browser's own
 * announcements are relayed to the *rest* of the room and never come back, but
 * the same person signed in twice would otherwise be told they had collided
 * with themselves.
 */
export const viewersOf = (
  sightings: ViewerSightings,
  selfId: string,
  now: number,
  ttlMs: number = TICKET_VIEWING_TTL_MS,
): readonly string[] =>
  Object.entries(sightings)
    .filter(([userId, at]) => userId !== selfId && now - at < ttlMs)
    .sort(([, left], [, right]) => right - left)
    .map(([userId]) => userId);

/** Drops what has gone quiet, so a long-open ticket does not grow a map. */
export const forgetStale = (
  sightings: ViewerSightings,
  now: number,
  ttlMs: number = TICKET_VIEWING_TTL_MS,
): ViewerSightings => {
  const live = Object.entries(sightings).filter(([, at]) => now - at < ttlMs);

  return live.length === Object.keys(sightings).length ? sightings : Object.fromEntries(live);
};
