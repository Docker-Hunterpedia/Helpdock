import type { WidgetMessage, WidgetMessagePage } from '@helpdock/schemas';

/**
 * One conversation's place in its thread (DOMAIN-RULES §7): the last `seq`
 * the widget holds, and the rule for what arrives next.
 *
 * - `seq <= last` — already held (a socket frame after the catch-up that
 *   returned it, or the visitor's own send echoed back): dropped.
 * - `seq == last + 1` — the next one: delivered.
 * - `seq > last + 1` — something was missed: `GET …/messages?after=<last>`,
 *   and everything it returns is delivered in order. A gap a visitor cannot
 *   see (an internal note has a `seq` too) is closed by the page's `lastSeq`,
 *   so it costs one catch-up and never another.
 *
 * Catch-ups run one at a time; a gap found while one is running asks for one
 * more afterwards rather than a second in parallel.
 */
export class ConversationCursor {
  readonly #fetchAfter: (after: number) => Promise<WidgetMessagePage>;
  readonly #deliver: (message: WidgetMessage) => void;
  readonly #onError: (error: unknown) => void;
  #last: number;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(options: {
    readonly after: number;
    readonly fetchAfter: (after: number) => Promise<WidgetMessagePage>;
    readonly deliver: (message: WidgetMessage) => void;
    readonly onError?: (error: unknown) => void;
  }) {
    this.#last = options.after;
    this.#fetchAfter = options.fetchAfter;
    this.#deliver = options.deliver;
    this.#onError = options.onError ?? (() => undefined);
  }

  get last(): number {
    return this.#last;
  }

  /** A message from the live channel, or the response to the visitor's own send. */
  receive(message: WidgetMessage): void {
    if (message.seq <= this.#last) {
      return;
    }
    if (message.seq === this.#last + 1 && this.#running === null) {
      this.#take(message);
      return;
    }
    void this.catchUp();
  }

  /** Reads everything after `last` from REST. Also what a reconnect calls. */
  catchUp(): Promise<void> {
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = null;
      if (this.#again) {
        this.#again = false;
        void this.catchUp();
      }
    });
    return this.#running;
  }

  async #drain(): Promise<void> {
    try {
      for (;;) {
        const page = await this.#fetchAfter(this.#last);
        for (const message of page.messages) {
          if (message.seq > this.#last) {
            this.#take(message);
          }
        }
        if (!page.hasMore) {
          this.#last = Math.max(this.#last, page.lastSeq);
          return;
        }
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  #take(message: WidgetMessage): void {
    this.#last = message.seq;
    this.#deliver(message);
  }
}
