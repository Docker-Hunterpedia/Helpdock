import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { currentRequestContext } from '../context/request-context.js';
import { type Logger, requestLogger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';
import { errorBody, mapError } from './error-response.js';

/**
 * The single exit for every failure. Without it Nest answers with its own body
 * shape, which differs per exception and, for an unhandled error, says nothing
 * a client can quote back.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  readonly #logger: Logger;

  constructor(@Inject(LOGGER) logger: Logger) {
    this.#logger = logger;
  }

  catch(error: unknown, host: ArgumentsHost): void {
    const mapped = mapError(error);
    // A failure raised before the middleware opened a context has no id to
    // quote. It still gets a body, because a filter that throws would leave the
    // client with nothing at all.
    const requestId = currentRequestContext()?.requestId ?? 'unknown';

    const log = requestLogger(this.#logger);
    if (mapped.unexpected) {
      log.error({ err: error, status: mapped.status }, 'request failed');
    } else {
      log.debug({ status: mapped.status, code: mapped.code }, 'request refused');
    }

    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(mapped.status).send(errorBody(mapped, requestId));
  }
}
