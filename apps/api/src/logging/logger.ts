import type { Env } from '@helpdock/config';
import type { LoggerService } from '@nestjs/common';
import {
  type DestinationStream,
  type Level,
  type LoggerOptions,
  type Logger as PinoLogger,
  pino,
} from 'pino';
import { currentRequestContext } from '../context/request-context.js';

/**
 * JSON logs with a request id and a brand id, and never a body (ARCHITECTURE
 * §14). The OpenTelemetry half of that section is M0-10; this file is only the
 * logger the rest of M0-04 writes through, so it stays small enough for M0-10
 * to extend rather than replace.
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
  readonly env: Pick<Env, 'APP_ROLE' | 'NODE_ENV'>;
  /** Overrides the level derived from `NODE_ENV`. Tests pass `'silent'`. */
  readonly level?: Level | 'silent';
  /** Where the lines go. Tests pass a collector. */
  readonly destination?: DestinationStream;
}

export const createLogger = ({ env, level, destination }: CreateLoggerOptions): Logger => {
  const options: LoggerOptions = {
    level: level ?? (env.NODE_ENV === 'production' ? 'info' : 'debug'),
    base: { role: env.APP_ROLE },
    redact: { paths: [...REDACTED], remove: true },
    formatters: {
      // The default is `{"level":30}`, which nothing but pino reads back.
      level: (label: string) => ({ level: label }),
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
};

/** Request id and brand id on every line written while a request is in flight. */
const requestBindings = (): Record<string, string> => {
  const context = currentRequestContext();
  if (context === undefined) {
    return {};
  }

  const brandId = context.targetBrandId ?? context.hostBrandId;
  return brandId === null
    ? { requestId: context.requestId }
    : { requestId: context.requestId, brandId };
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
