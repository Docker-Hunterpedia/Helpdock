/**
 * "Remind me every minute while a chat waits" (M14-25).
 *
 * One interval per waiting chat. On each beat the chat is asked about again
 * (the caller reads it over REST, because a frame is a notification and REST
 * is the truth, DOMAIN-RULES §7): still waiting means the sound plays, picked
 * up, closed or gone means the interval ends. Nothing here knows about tickets
 * or audio, so the stopping rule is testable with fake timers.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export class WaitingChatReminders {
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #failures = new Map<string, number>();
  readonly #intervalMs: number;
  readonly #stillWaiting: (ticketId: string) => Promise<boolean>;
  readonly #remind: (ticketId: string) => void;

  constructor(options: {
    readonly intervalMs: number;
    /** True while the chat is unassigned and open; a rejection counts as "unknown" and is retried a few beats. */
    readonly stillWaiting: (ticketId: string) => Promise<boolean>;
    readonly remind: (ticketId: string) => void;
  }) {
    this.#intervalMs = options.intervalMs;
    this.#stillWaiting = options.stillWaiting;
    this.#remind = options.remind;
  }

  track(ticketId: string): void {
    if (this.#timers.has(ticketId)) {
      return;
    }

    this.#timers.set(
      ticketId,
      setInterval(() => {
        void this.#beat(ticketId);
      }, this.#intervalMs),
    );
  }

  /** The chat was picked up, closed or merged, or the person turned the reminder off. */
  release(ticketId: string): void {
    this.#failures.delete(ticketId);
    const timer = this.#timers.get(ticketId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.#timers.delete(ticketId);
    }
  }

  has(ticketId: string): boolean {
    return this.#timers.has(ticketId);
  }

  ids(): readonly string[] {
    return [...this.#timers.keys()];
  }

  clear(): void {
    for (const ticketId of this.ids()) {
      this.release(ticketId);
    }
  }

  async #beat(ticketId: string): Promise<void> {
    let waiting: boolean;
    try {
      waiting = await this.#stillWaiting(ticketId);
    } catch {
      // A failed read says nothing about the chat, so the next beat asks again
      // — but a chat that can no longer be read at all (moved out of this
      // person's departments) must not ring for ever.
      const failures = (this.#failures.get(ticketId) ?? 0) + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        this.release(ticketId);
      } else {
        this.#failures.set(ticketId, failures);
      }
      return;
    }
    this.#failures.delete(ticketId);

    // Released while the read was in flight: stay quiet.
    if (!this.#timers.has(ticketId)) {
      return;
    }
    if (waiting) {
      this.#remind(ticketId);
    } else {
      this.release(ticketId);
    }
  }
}
