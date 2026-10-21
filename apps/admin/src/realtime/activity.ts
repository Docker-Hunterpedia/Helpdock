import { PRESENCE_ACTIVITY_REPORT_INTERVAL_MS } from '@helpdock/schemas';

/**
 * M14-18: the browser's half of "mark idle agents away". The server cannot tell
 * a person reading a ticket from one who has gone to lunch, because the socket
 * stays open either way, so the browser says "I was active in the last minute"
 * and the server — which knows the department's limit — decides what silence
 * means (DOMAIN-RULES §12).
 *
 * Only that fact is sent, at most once per interval: never which key, which
 * element or what was typed. Pointer, key, wheel and touch events, the window gaining
 * focus, and the tab becoming visible again count as activity.
 *
 * An event inside the interval is not dropped: it schedules one report for the
 * end of it, so the server's clock is never more than an interval behind the
 * person, which is why the shortest department limit is ten minutes.
 */
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'] as const;

export interface WatchActivityOptions {
  /** Sends the report. A failure is the caller's to swallow; the next event tries again. */
  report(): void;
  readonly intervalMs?: number;
  /** The window, or a stand-in in a test. */
  readonly target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** Whether the tab is showing, so a hidden tab's `visibilitychange` is not a return. */
  readonly isVisible?: () => boolean;
}

export interface ActivityWatcher {
  stop(): void;
}

export const watchActivity = ({
  report,
  intervalMs = PRESENCE_ACTIVITY_REPORT_INTERVAL_MS,
  target = window,
  isVisible = () => document.visibilityState === 'visible',
}: WatchActivityOptions): ActivityWatcher => {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | undefined;

  const send = (): void => {
    lastSentAt = Date.now();
    report();
  };

  const seen = (): void => {
    if (trailing !== undefined) {
      return;
    }

    const wait = lastSentAt + intervalMs - Date.now();
    if (wait <= 0) {
      send();
      return;
    }

    trailing = setTimeout(() => {
      trailing = undefined;
      send();
    }, wait);
  };

  const shown = (): void => {
    if (isVisible()) {
      seen();
    }
  };

  for (const event of ACTIVITY_EVENTS) {
    target.addEventListener(event, seen, { passive: true });
  }
  target.addEventListener('visibilitychange', shown);
  // Opening the app is activity, and the first thing the server hears from this tab.
  send();

  return {
    stop: () => {
      clearTimeout(trailing);
      trailing = undefined;
      for (const event of ACTIVITY_EVENTS) {
        target.removeEventListener(event, seen);
      }
      target.removeEventListener('visibilitychange', shown);
    },
  };
};
