import type { DbTransaction } from '@helpdock/db';
import type { JobHandler } from './consumer.js';
import { OUTBOX_EVENT_NAME, type OutboxEventPayload, outboxEventPayloadSchema } from './jobs.js';
import type { JobLogger } from './logger.js';
import { lockOrderingKeys, outboxOrderingKeys } from './ordering.js';
import { parsePayload } from './validation.js';

/**
 * `outbox.event` is one queue job for every kind of side effect, so something
 * has to turn `event` into code. That is this registry: a module that owns an
 * effect registers a handler for its event name, and the consumer looks it up
 * inside the brand's transaction. Adding a side effect is a handler, never a new
 * queue and never a `queue.add` in a service.
 *
 * **An event may have several handlers**, one per **subscriber** (M3). A
 * ticket change is a socket frame (M1), a clock to move (M3-02), a reason to
 * evaluate workflow rules (M3-03) and somebody to tell (M3-07); each module
 * registers its own handler under its own subscriber name rather than one
 * module calling the others. The module that owns the event takes the
 * {@link DEFAULT_SUBSCRIBER} slot; every other module names itself.
 *
 * They run in registration order — which is start-up order, fixed by the
 * worker's boot sequence — inside the one transaction the job's receipt is
 * claimed in, so one handler that throws rolls back what the others wrote and
 * the job is retried whole, which every handler already tolerates because
 * every delivery is at least once (DOMAIN-RULES §6). A subscriber registering
 * twice for one event, or one function registered twice, is a start-up that
 * ran twice and would run a side effect twice per delivery, so both are
 * refused.
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

/** Who a handler belongs to. One handler per event per subscriber. */
export const DEFAULT_SUBSCRIBER = 'default';

export interface OutboxDispatcher {
  register(event: string, handler: OutboxEventHandler, subscriber?: string): void;
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
  const handlers = new Map<string, Map<string, OutboxEventHandler>>();

  const register = (
    event: string,
    handler: OutboxEventHandler,
    subscriber = DEFAULT_SUBSCRIBER,
  ): void => {
    parsePayload('outbox event name', OUTBOX_EVENT_NAME, event);
    const subscribers = handlers.get(event) ?? new Map<string, OutboxEventHandler>();
    if (subscribers.has(subscriber)) {
      throw new Error(
        `An outbox handler for ${event} is already registered${subscriber === DEFAULT_SUBSCRIBER ? '' : ` by ${subscriber}`}.`,
      );
    }
    if ([...subscribers.values()].includes(handler)) {
      throw new Error(`This outbox handler for ${event} is already registered.`);
    }
    subscribers.set(subscriber, handler);
    handlers.set(event, subscribers);
  };

  register(SETTINGS_CHANGED_EVENT, logSettingsChanged);

  return {
    register,
    get events(): readonly string[] {
      return [...handlers.keys()].sort();
    },
    dispatch: async (context) => {
      const subscribers = handlers.get(context.event);
      if (subscribers === undefined) {
        throw new UnknownOutboxEventError(context.event, [...handlers.keys()]);
      }
      for (const handler of subscribers.values()) {
        await handler(context);
      }
    },
  };
};

/** The registry the worker uses. Modules register into it as they are imported. */
export const outboxEvents = createOutboxDispatcher();

export const registerEventHandler = (
  event: string,
  handler: OutboxEventHandler,
  subscriber?: string,
): void => {
  outboxEvents.register(event, handler, subscriber);
};

/**
 * The `outbox.event` handler to hand {@link ./consumer.js createWorker}. It
 * takes the event's ordering locks before any subscriber runs, so no other
 * worker process runs an event of the same ticket until this one commits
 * (`ordering.ts`).
 */
export const createOutboxEventHandler =
  (dispatcher: OutboxDispatcher = outboxEvents): JobHandler<OutboxEventPayload> =>
  async ({ payload, tx, log }) => {
    await lockOrderingKeys(tx, outboxOrderingKeys(payload));
    await dispatcher.dispatch({
      outboxId: payload.outboxId,
      brandId: payload.brandId,
      event: payload.event,
      payload: payload.payload,
      tx,
      log,
    });
  };

/**
 * The ordering keys of a raw `outbox.event` job, for {@link ./consumer.js createWorker}'s
 * `serialize` option. A payload that does not parse has none: it is refused as
 * unrecoverable by the processor anyway, and must not hold up anything else.
 */
export const outboxJobOrderingKeys = (data: unknown): readonly string[] => {
  const parsed = outboxEventPayloadSchema.safeParse(data);
  return parsed.success ? outboxOrderingKeys(parsed.data) : [];
};
