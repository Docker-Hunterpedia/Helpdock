import type { TicketDetail, TicketViewingActivity } from '@helpdock/schemas';
import { departmentRoom, TICKET_VIEWING_INTERVAL_MS, ticketRoom } from '@helpdock/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTicketsApi } from '../../auth/session.tsx';
import { useRealtime } from '../../realtime/realtime-provider.tsx';
import {
  forgetStale,
  noteViewing,
  type Viewer,
  type ViewerSightings,
  viewersOf,
} from '../../tickets/collision.js';
import { ticketKeys } from '../../tickets/keys.js';
import { applyCatchUp, lastSeq } from '../../tickets/thread.js';

/**
 * The socket half of the workspace, which is deliberately small.
 *
 * > Socket.IO does not guarantee delivery. The REST API is the source of truth;
 * > sockets are notifications. — DOMAIN-RULES §7
 *
 * So no frame is ever applied to the cache. A `ticket:changed` re-reads the
 * ticket; a `ticket:message` reads `?after=<the highest seq held>`, which is
 * also exactly what a reconnection does, so a missed frame and a dropped
 * connection are the same recovery and there is only one of it.
 */

export function useTicketRoom(
  brandId: string,
  ticketId: string | null,
  /** Excluded from the result: the same person signed in twice is not a collision. */
  selfId: string,
  /** M1-09: `replying` while this browser's composer has something in it. */
  viewingActivity: TicketViewingActivity = 'viewing',
): { readonly viewers: readonly Viewer[] } {
  const { client } = useRealtime();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const [sightings, setSightings] = useState<ViewerSightings>({});
  // Read by the interval below, so a change of activity does not tear the room
  // down and join it again; the effect after this one says it at once instead.
  const activityRef = useRef(viewingActivity);
  activityRef.current = viewingActivity;

  useEffect(() => {
    if (ticketId === null) {
      setSightings({});
      return;
    }

    setSightings({});
    const leave = client.joinRoom(ticketRoom(ticketId));

    const catchUp = async (): Promise<void> => {
      const key = ticketKeys.detail(brandId, ticketId);
      const held = queryClient.getQueryData<TicketDetail>(key);
      if (held === undefined) {
        await queryClient.invalidateQueries({ queryKey: key });
        return;
      }

      const [ticket, page, activity] = await Promise.all([
        api.ticket(brandId, ticketId),
        api.messages(brandId, ticketId, lastSeq(held.messages.messages)),
        api.activity(brandId, ticketId),
      ]);

      queryClient.setQueryData<TicketDetail>(key, {
        ticket: ticket.ticket,
        messages: {
          messages: applyCatchUp(held.messages.messages, page.messages),
          nextAfter: page.nextAfter,
        },
        activity: activity.activity,
        // M1-09: the merge read comes with the ticket, and a catch-up that
        // dropped it would take the merged block off the screen until a reload.
        ...mergeViewOf(ticket),
      });
    };

    const unsubscribe = client.subscribe({
      connection: (state) => {
        // A socket that has just come back has missed whatever happened while
        // it was away, and the room it holds was authorised before that.
        if (state === 'connected') {
          void catchUp();
        }
      },
      ticketChanged: (change) => {
        if (change.ticketId === ticketId) {
          void catchUp();
        }
      },
      ticketMessage: (event) => {
        if (event.ticketId === ticketId) {
          void catchUp();
        }
      },
      ticketViewing: (viewing) => {
        if (viewing.ticketId === ticketId) {
          setSightings((current) =>
            noteViewing(current, viewing.userId, viewing.activity, Date.now()),
          );
        }
      },
    });

    // Say so at once and then keep saying so: the announcement is what the
    // other browsers in the room derive the collision pill from, and a name
    // nobody repeats is dropped after `TICKET_VIEWING_TTL_MS`.
    client.announceViewing(ticketId, activityRef.current);
    const announce = setInterval(() => {
      client.announceViewing(ticketId, activityRef.current);
      setSightings((current) => forgetStale(current, Date.now()));
    }, TICKET_VIEWING_INTERVAL_MS);

    return () => {
      clearInterval(announce);
      unsubscribe();
      leave();
    };
  }, [client, api, queryClient, brandId, ticketId]);

  // The composer filling or emptying is said at once rather than at the next
  // interval: "is replying" thirty seconds late is a warning after the fact.
  const announced = useRef(viewingActivity);
  useEffect(() => {
    if (ticketId === null || announced.current === viewingActivity) {
      return;
    }
    announced.current = viewingActivity;
    client.announceViewing(ticketId, viewingActivity);
  }, [client, ticketId, viewingActivity]);

  return { viewers: viewersOf(sightings, selfId, Date.now()) };
}

/** The merge half of a ticket read, carried over by a catch-up. */
const mergeViewOf = (read: TicketDetail): Partial<TicketDetail> => ({
  ...(read.merged === undefined ? {} : { merged: read.merged }),
  ...(read.mergedInto === undefined ? {} : { mergedInto: read.mergedInto }),
  ...(read.related === undefined ? {} : { related: read.related }),
});

/**
 * The queue's half: a department room per department on screen, so a ticket
 * created by somebody else appears in a list nobody was looking at.
 *
 * The rooms are the departments of the tickets the list is showing, which is
 * the closest thing to "the queues this person has open" that the api can
 * answer without a second read.
 */
export function useDepartmentRooms(brandId: string, departmentIds: readonly string[]): void {
  const { client } = useRealtime();
  const queryClient = useQueryClient();
  const key = [...new Set(departmentIds)].sort().join(',');

  useEffect(() => {
    if (key === '') {
      return;
    }

    const leaves = key
      .split(',')
      .map((departmentId) => client.joinRoom(departmentRoom(departmentId)));
    const unsubscribe = client.subscribe({
      ticketChanged: () => {
        void queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) });
      },
      ticketMessage: () => {
        void queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) });
      },
    });

    return () => {
      unsubscribe();
      for (const leave of leaves) {
        leave();
      }
    };
  }, [client, queryClient, brandId, key]);
}
