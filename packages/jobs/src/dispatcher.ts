import type { DbTransaction } from '@helpdock/db';
import type { JobHandler } from './consumer.js';
import { OUTBOX_EVENT_NAME, type OutboxEventPayload } from './jobs.js';
import type { JobLogger } from './logger.js';
import { parsePayload } from './validation.js';

/**
 * `outbox.event` is one queue job for every kind of side effect, so something
 * has to turn `event` into code. That is this registry: a module that owns an
 * effect registers a handler for its event name, and the consumer looks it up
 * inside the brand's transaction. Adding a side effect is a handler, never a new
 * queue and never a `queue.add` in a service.
 */

export interface OutboxEventContext {
  /** The `outbox` row this came from. Also the BullMQ job id. */
  readonly outboxId: string;
  readonly brandId: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  /** The brand's transaction, already carrying the system tenant context. */
  readonly tx: DbTransaction;
  readonly log: JobLogger;
}

export type OutboxEventHandler = (context: OutboxEventContext) => Promise<void>;

/** No handler is registered for the event. Retried, then left in the failed set. */
export class UnknownOutboxEventError extends Error {
  readonly event: string;

  constructor(event: string, known: readonly string[]) {
    super(
      `No outbox handler is registered for ${event}. Registered events: ${known.length === 0 ? 'none' : known.join(', ')}.`,
    );
    this.name = 'UnknownOutboxEventError';
    this.event = event;
  }
}

export interface OutboxDispatcher {
  register(event: string, handler: OutboxEventHandler): void;
  /** Registered event names, sorted. The System page lists them. */
  readonly events: readonly string[];
  dispatch(context: OutboxEventContext): Promise<void>;
}

/** The smoke path: an event with a handler that only logs, so the chain can be proved end to end. */
export const SETTINGS_CHANGED_EVENT = 'settings.changed';

/**
 * Settings invalidation already happens over Redis pub/sub (ARCHITECTURE §4);
 * this exists so there is one registered event in a fresh install. It logs the
 * key and never the value, because a setting can be a secret (AGENTS.md).
 */
const logSettingsChanged: OutboxEventHandler = ({ brandId, outboxId, payload, log }) => {
  log.info(
    {
      event: SETTINGS_CHANGED_EVENT,
      brandId,
      outboxId,
      key: typeof payload.key === 'string' ? payload.key : undefined,
    },
    'settings changed',
  );
  return Promise.resolve();
};

/**
 * A registry with the built-in handlers already in it. Tests build their own
 * rather than mutating a shared one.
 */
export const createOutboxDispatcher = (): OutboxDispatcher => {
  const handlers = new Map<string, OutboxEventHandler>();

  const register = (event: string, handler: OutboxEventHandler): void => {
    parsePayload('outbox event name', OUTBOX_EVENT_NAME, event);
    if (handlers.has(event)) {
      throw new Error(`An outbox handler for ${event} is already registered.`);
    }
    handlers.set(event, handler);
  };

  register(SETTINGS_CHANGED_EVENT, logSettingsChanged);

  return {
    register,
    get events(): readonly string[] {
      return [...handlers.keys()].sort();
    },
    dispatch: async (context) => {
      const handler = handlers.get(context.event);
      if (handler === undefined) {
        throw new UnknownOutboxEventError(context.event, [...handlers.keys()]);
      }
      await handler(context);
    },
  };
};

/** The registry the worker uses. Modules register into it as they are imported. */
export const outboxEvents = createOutboxDispatcher();

export const registerEventHandler = (event: string, handler: OutboxEventHandler): void => {
  outboxEvents.register(event, handler);
};

/** The `outbox.event` handler to hand {@link ./consumer.js createWorker}. */
export const createOutboxEventHandler =
  (dispatcher: OutboxDispatcher = outboxEvents): JobHandler<OutboxEventPayload> =>
  ({ payload, tx, log }) =>
    dispatcher.dispatch({
      outboxId: payload.outboxId,
      brandId: payload.brandId,
      event: payload.event,
      payload: payload.payload,
      tx,
      log,
    });
