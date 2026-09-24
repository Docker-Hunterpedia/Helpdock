import type { PresenceMap, PresenceStatus, SettablePresenceStatus } from '@helpdock/schemas';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { currentBrand, useAuthApi, useSession } from '../auth/session.tsx';
import { watchActivity } from './activity.js';
import type { RealtimeClient, RealtimeConnection } from './client.js';
import { applyPresenceChange, statusOf } from './presence-map.js';
import { createRealtimeClient } from './select-client.js';

/**
 * The one socket this tab holds, for as long as there is a session.
 *
 * It lives below `RequireSession` on purpose: a connection needs a principal, a
 * brand and a token, and none of those exist on the sign-in screen. Switching
 * brand re-targets the same client rather than opening a second one.
 *
 * REST first, then events: the map is read from
 * `GET /api/brands/:brandId/presence` and `presence:changed` is applied to it,
 * which is the delivery contract of DOMAIN-RULES §7 — sockets are
 * notifications and REST is the truth.
 */

export interface Realtime {
  readonly connection: RealtimeConnection;
  /**
   * The client itself, for the screens that hold a room of their own. The
   * ticket workspace is the only one today: it joins `ticket:<id>` while a
   * ticket is open and `department:<id>` while a queue is, and no provider can
   * know which those are.
   */
  readonly client: RealtimeClient;
  /** This person's own presence in the current brand. */
  readonly status: PresenceStatus;
  setStatus(status: SettablePresenceStatus): void;
  presenceIn(brandId: string): PresenceMap;
}

const RealtimeContext = createContext<Realtime | null>(null);

/** One frozen instance, so "nobody is here" is referentially stable. */
const EMPTY_PRESENCE: PresenceMap = Object.freeze({});

export interface RealtimeProviderProps {
  readonly children: ReactNode;
  /** Tests and the mock adapter pass their own; production builds one. */
  readonly client?: RealtimeClient;
  /** Overridden by the away-timer test; production uses DOMAIN-RULES §12's five minutes. */
  readonly idleMs?: number;
}

export function RealtimeProvider({ children, client, idleMs }: RealtimeProviderProps): ReactNode {
  const api = useAuthApi();
  const session = useSession();
  const brandId = currentBrand(session).id;
  const userId = session.user.id;

  const realtimeClient = useMemo(() => client ?? createRealtimeClient(api), [client, api]);
  const [connection, setConnection] = useState<RealtimeConnection>('connecting');
  const [presence, setPresence] = useState<PresenceMap>(EMPTY_PRESENCE);
  const status = statusOf(presence, userId);
  /**
   * What this person's status is right now, readable synchronously.
   *
   * The activity watcher needs it: the watcher is set up once and must not be
   * torn down and rebuilt every time the status changes, so it cannot close
   * over `status`. Reconciled in an effect — a render has to be free of side
   * effects — and written directly by `setStatus`, because a caller must not
   * see a stale value in the window before that effect has flushed.
   */
  const statusRef = useRef<PresenceStatus>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let live = true;
    const unsubscribe = realtimeClient.subscribe({
      connection: setConnection,
      presenceChanged: (change) => {
        if (change.brandId === brandId) {
          setPresence((current) => applyPresenceChange(current, change));
        }
      },
    });

    realtimeClient.start(brandId);
    void realtimeClient.presence(brandId).then((map) => {
      if (live) {
        // Whatever arrived over the socket while this was in flight wins: it is
        // newer than the snapshot.
        setPresence((current) => ({ ...map, ...current }));
      }
    });

    return () => {
      live = false;
      unsubscribe();
      realtimeClient.stop();
      setPresence(EMPTY_PRESENCE);
    };
  }, [realtimeClient, brandId]);

  /**
   * Announce a status this person is not already in, and show it at once
   * rather than waiting for the round trip (presence is ephemeral; nothing
   * depends on the acknowledgement).
   *
   * The early return is what makes it idempotent. Two things call this — the
   * account menu and the away timer — and they can agree: without the guard, a
   * toggle to `away` a moment after the timer reached the same conclusion
   * would put a second `presence:set` on the wire for no change at all. The
   * ref is updated before the state so that the second caller sees the first
   * one's decision even within a single tick.
   */
  const setStatus = useCallback(
    (status: SettablePresenceStatus) => {
      if (statusRef.current === status) {
        return;
      }
      statusRef.current = status;

      void realtimeClient.setPresence(status);
      setPresence((current) => applyPresenceChange(current, { userId, brandId, status }));
    },
    [realtimeClient, brandId, userId],
  );

  useEffect(() => {
    const watcher = watchActivity({
      ...(idleMs === undefined ? {} : { idleMs }),
      onIdle: () => {
        if (statusRef.current === 'online') {
          setStatus('away');
        }
      },
      onActive: () => {
        if (statusRef.current === 'away') {
          setStatus('online');
        }
      },
    });

    return () => {
      watcher.stop();
    };
  }, [setStatus, idleMs]);

  const value = useMemo<Realtime>(
    () => ({
      connection,
      client: realtimeClient,
      status,
      setStatus,
      // The same object for every brand but this one, so a consumer that puts
      // the result in a dependency list is not re-run on every render.
      presenceIn: (asked) => (asked === brandId ? presence : EMPTY_PRESENCE),
    }),
    [connection, realtimeClient, presence, status, setStatus, brandId],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): Realtime {
  const realtime = useContext(RealtimeContext);
  if (!realtime) {
    throw new Error('useRealtime needs a <RealtimeProvider> above it');
  }

  return realtime;
}

/** Who is online in one brand. Anyone absent from the map is offline. */
export function usePresence(brandId: string): PresenceMap {
  return useRealtime().presenceIn(brandId);
}
