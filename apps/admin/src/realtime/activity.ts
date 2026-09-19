import { PRESENCE_AWAY_AFTER_MS } from '@helpdock/schemas';

/**
 * "Away" is five minutes without a sign of life (DOMAIN-RULES §12). The server
 * cannot tell: a socket stays open whether the person is reading a ticket or
 * has gone to lunch, so the browser is the only thing that knows and it says so
 * with `presence:set`.
 *
 * Pointer, key and wheel events, plus the tab becoming visible again, count as
 * a sign of life. Scroll does not have its own entry because it is driven by
 * one of those.
 */
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface WatchActivityOptions {
  onIdle(): void;
  onActive(): void;
  readonly idleMs?: number;
  /** The document, or a stand-in in a test. */
  readonly target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

export interface ActivityWatcher {
  stop(): void;
}

export const watchActivity = ({
  onIdle,
  onActive,
  idleMs = PRESENCE_AWAY_AFTER_MS,
  target = window,
}: WatchActivityOptions): ActivityWatcher => {
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      onIdle();
    }, idleMs);
  };

  const seen = (): void => {
    if (idle) {
      idle = false;
      onActive();
    }
    arm();
  };

  for (const event of ACTIVITY_EVENTS) {
    target.addEventListener(event, seen, { passive: true });
  }
  // A tab that was hidden and comes back is somebody returning to it, which is
  // the one "activity" that is not an input event.
  target.addEventListener('visibilitychange', seen);
  arm();

  return {
    stop: () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) {
        target.removeEventListener(event, seen);
      }
      target.removeEventListener('visibilitychange', seen);
    },
  };
};
