import { Redis } from 'ioredis';
import { isSettingKey, type SettingKey } from './registry.js';

/** Every replica listens here, so an admin change applies without a restart (ARCHITECTURE §4). */
export const SETTINGS_INVALIDATION_CHANNEL = 'helpdock:settings:invalidate';

export type InvalidationHandler = (key: SettingKey) => void;

export interface Invalidation {
  publish(key: SettingKey): Promise<void>;
  /** Registers a handler and returns the function that removes it again. */
  subscribe(handler: InvalidationHandler): () => void;
  close(): Promise<void>;
}

const EVENT_TYPE = 'invalidate';

/**
 * Single-process invalidation. Enough for tests, for `pnpm dev` and for an
 * install running one api replica and no worker.
 */
export class LocalInvalidation implements Invalidation {
  readonly #target = new EventTarget();
  readonly #listeners = new Set<(event: Event) => void>();

  publish(key: SettingKey): Promise<void> {
    this.#target.dispatchEvent(new CustomEvent(EVENT_TYPE, { detail: key }));
    return Promise.resolve();
  }

  subscribe(handler: InvalidationHandler): () => void {
    const listener = (event: Event): void => {
      handler((event as CustomEvent<SettingKey>).detail);
    };

    this.#target.addEventListener(EVENT_TYPE, listener);
    this.#listeners.add(listener);
    return () => {
      this.#remove(listener);
    };
  }

  close(): Promise<void> {
    for (const listener of [...this.#listeners]) {
      this.#remove(listener);
    }
    return Promise.resolve();
  }

  #remove(listener: (event: Event) => void): void {
    this.#target.removeEventListener(EVENT_TYPE, listener);
    this.#listeners.delete(listener);
  }
}

export interface RedisInvalidationOptions {
  readonly url: string;
  /**
   * Where connection errors go. Optional only until M0-10 wires pino through
   * the api and the worker, at which point every caller passes a logger.
   */
  readonly onError?: (error: Error) => void;
}

/**
 * Redis pub/sub invalidation across replicas. A connection in subscriber mode
 * accepts no other command, so the publisher and the subscriber are two
 * separate connections and {@link close} closes both.
 */
export class RedisInvalidation implements Invalidation {
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #handlers = new Set<InvalidationHandler>();

  private constructor(publisher: Redis, subscriber: Redis) {
    this.#publisher = publisher;
    this.#subscriber = subscriber;
  }

  static async connect(options: RedisInvalidationOptions): Promise<RedisInvalidation> {
    const publisher = new Redis(options.url, { lazyConnect: true });
    const subscriber = new Redis(options.url, { lazyConnect: true });

    // ioredis emits `error` on every reconnect attempt; an EventEmitter with no
    // error listener would take the process down with it.
    const onError = options.onError ?? ((): void => {});
    publisher.on('error', onError);
    subscriber.on('error', onError);

    const invalidation = new RedisInvalidation(publisher, subscriber);
    subscriber.on('message', (_channel: string, message: string) => {
      invalidation.#dispatch(message);
    });

    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.subscribe(SETTINGS_INVALIDATION_CHANNEL);

    return invalidation;
  }

  #dispatch(message: string): void {
    // A key this build does not know comes from a replica running a newer
    // version. There is nothing cached under it here, so dropping it is right.
    if (!isSettingKey(message)) {
      return;
    }

    for (const handler of this.#handlers) {
      handler(message);
    }
  }

  async publish(key: SettingKey): Promise<void> {
    await this.#publisher.publish(SETTINGS_INVALIDATION_CHANNEL, key);
  }

  subscribe(handler: InvalidationHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.#handlers.clear();
    await Promise.all([this.#publisher.quit(), this.#subscriber.quit()]);
  }
}
