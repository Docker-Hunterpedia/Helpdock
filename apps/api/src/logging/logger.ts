import type { Env } from '@helpdock/config';
import type { LoggerService } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import {
  type DestinationStream,
  type Level,
  type LoggerOptions,
  type Logger as PinoLogger,
  pino,
} from 'pino';
import { principalIdOf } from '../auth/principal.js';
import { currentRequestContext } from '../context/request-context.js';

/**
 * JSON logs with a request id, a brand id, who asked and the trace the line
 * belongs to — and never a body (ARCHITECTURE §14). `LOG_LEVEL` sets the level;
 * `NODE_ENV=development` prettifies the lines instead of emitting JSON.
 *
 * What an operator does with all of it is in `docs/guides/operations.md`.
 *
 * `nestjs-pino` was not used: it keeps its own AsyncLocalStorage for request
 * context, and this app already has one for the tenant transaction. Two stores
 * holding two halves of the same request is the kind of thing that drifts.
 */

export type Logger = PinoLogger;

/**
 * Keys pino removes. Nothing in the api logs a body or a header on purpose;
 * this is the net under that promise, for the day something logs an error
 * object that happens to carry a request.
 *
 * A pino `*` matches exactly one level, so a credential is listed both at the
 * top level and one level down, which is where a serialised request or job
 * payload would put it.
 */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hd-dev-principal"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  'token',
  'secret',
  '*.password',
  '*.token',
  '*.secret',
  // A driver error carries the statement and the values it was given. Those
  // values are the row: an email address, a ticket body, a password hash.
  // Logging an error must not become a way to log a body (ARCHITECTURE §14).
  'err.query',
  'err.parameters',
  'err.cause.query',
  'err.cause.parameters',
] as const;

export interface CreateLoggerOptions {
  readonly env: Pick<Env, 'APP_ROLE' | 'NODE_ENV' | 'LOG_LEVEL'>;
  /** Overrides `LOG_LEVEL`. Tests pass `'silent'`. */
  readonly level?: Level | 'silent';
  /** Where the lines go. Tests pass a collector, and then nothing is prettified. */
  readonly destination?: DestinationStream;
}

/**
 * Human-readable lines, in development only.
 *
 * `pino-pretty` is a development dependency and is named rather than imported,
 * so a production image that never installs it still starts: pino resolves a
 * transport target lazily, in the worker thread it spawns, and that only
 * happens when `NODE_ENV=development` asks for it.
 *
 * It is never used when a destination was given. A transport and an explicit
 * stream are two different places for the lines to go, and a test that passes a
 * collector means the collector.
 */
const prettyTransport = () =>
  ({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
  }) as const;

/**
 * Exactly what pino is configured with. Separated from {@link createLogger} so a
 * test can read the configuration rather than reach into pino's internals to
 * find out whether a transport was attached.
 */
export const loggerOptions = ({ env, level, destination }: CreateLoggerOptions): LoggerOptions => {
  const pretty = env.NODE_ENV === 'development' && destination === undefined;

  return {
    level: level ?? env.LOG_LEVEL,
    base: { role: env.APP_ROLE },
    redact: { paths: [...REDACTED], remove: true },
    formatters: {
      // The default is `{"level":30}`, which nothing but pino reads back.
      level: (label: string) => ({ level: label }),
    },
    // Spread rather than assigned: with `exactOptionalPropertyTypes`, an
    // explicit `transport: undefined` is not the same as no transport at all,
    // and pino reads the presence of the key.
    ...(pretty ? { transport: prettyTransport() } : {}),
  };
};

export const createLogger = (options: CreateLoggerOptions): Logger => {
  const { destination } = options;

  return destination === undefined
    ? pino(loggerOptions(options))
    : pino(loggerOptions(options), destination);
};

/**
 * The correlation keys on every line written while a request is in flight:
 * request id, brand id, who is asking, and the trace the line belongs to
 * (ARCHITECTURE §14).
 *
 * `principalId` and never an email, a name or a session: the id joins a line to
 * `audit_log`, which is what an investigation needs, and it is not a personal
 * detail spread across a log stream.
 */
const requestBindings = (): Record<string, string> => {
  const context = currentRequestContext();
  if (context === undefined) {
    return traceBindings();
  }

  const brandId = context.targetBrandId ?? context.hostBrandId;
  const principal = context.principal;

  return {
    requestId: context.requestId,
    ...(brandId === null ? {} : { brandId }),
    ...(principal === null ? {} : { principalId: principalIdOf(principal) }),
    ...traceBindings(),
  };
};

/**
 * The active span's ids, when tracing is on. When it is off there is no active
 * span and this is empty, which is why nothing else has to know whether an
 * OTLP endpoint was configured.
 *
 * Logging both the trace id and the request id is what joins the two views: the
 * trace shows where the time went, `x-request-id` is what a client can quote,
 * and a line carrying both lets one be found from the other.
 */
const traceBindings = (): Record<string, string> => {
  const span = trace.getActiveSpan()?.spanContext();
  if (span === undefined || !isSpanContextValid(span)) {
    return {};
  }

  return { traceId: span.traceId, spanId: span.spanId };
};

/**
 * Nest's own lifecycle logging, routed through pino so there is one stream and
 * one format. Nest calls these with `(message, ...optionalParams)`, where the
 * last parameter is a context string and, for `error`, a stack.
 */
export class NestPinoLogger implements LoggerService {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  log(message: unknown, ...params: unknown[]): void {
    this.#write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.#write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.#write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.#write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.#write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.#write('fatal', message, params);
  }

  #write(level: Level, message: unknown, params: readonly unknown[]): void {
    const context = params.at(-1);
    this.#logger[level](
      {
        ...requestBindings(),
        ...(typeof context === 'string' ? { context } : {}),
      },
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }
}

/** A child logger carrying the current request's bindings. */
export const requestLogger = (logger: Logger): Logger => logger.child(requestBindings());
