/**
 * The relay's sleep between cycles, which either times out or is cut short by a
 * `LISTEN outbox` notification. It is separate from the relay because the
 * awkward part is not the loop but the race: a notification that arrives while a
 * cycle is running must not be lost, or the row it announced waits a full poll
 * interval for no reason.
 */
export interface Waiter {
  /** Resolves after `ms`, or as soon as {@link notify} is called. */
  wait(ms: number): Promise<void>;
  /** Ends the current wait, or skips the next one if none is in progress. */
  notify(): void;
}

export const createWaiter = (): Waiter => {
  /** Ends the wait in progress. Undefined while the caller is doing something else. */
  let end: (() => void) | undefined;
  /** A notification with no wait to interrupt, redeemed by the next `wait`. */
  let pending = false;

  return {
    wait: (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (pending) {
          pending = false;
          resolve();
          return;
        }

        const timer = setTimeout(() => {
          end = undefined;
          resolve();
        }, ms);
        // A sleeping relay is not a reason to keep the process alive; whatever
        // hosts it decides that.
        timer.unref();

        end = () => {
          clearTimeout(timer);
          end = undefined;
          pending = false;
          resolve();
        };
      }),

    notify: (): void => {
      pending = true;
      end?.();
    },
  };
};
