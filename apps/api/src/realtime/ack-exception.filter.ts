import { type SocketAck, socketErrorSchema } from '@helpdock/schemas';
import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Logger } from '../logging/logger.js';
import { LOGGER } from '../runtime/tokens.js';

/**
 * The single exit for a failed socket event, and the reason a refusal is a
 * typed acknowledgement rather than something the client has to listen for.
 *
 * Nest's own WebSocket filter emits an `exception` event on the socket, which
 * is fine for a fire-and-forget message but wrong for one the caller is
 * awaiting: `room:join` would resolve with nothing and the client would sit
 * there. Socket.IO passes the acknowledgement callback as the last handler
 * argument, so this filter answers through it when there is one and falls back
 * to Nest's behaviour when there is not.
 */
@Catch()
export class AckExceptionFilter implements ExceptionFilter {
  readonly #logger: Logger;

  constructor(@Inject(LOGGER) logger: Logger) {
    this.#logger = logger;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ack = ackOf(host.getArgs());
    const error = socketErrorOf(exception);

    if (error === null) {
      // Not a refusal: a bug. The client is told only that something failed,
      // and the detail goes to the log where it belongs.
      this.#logger.error({ err: exception }, 'A socket event failed');
    } else {
      this.#logger.debug({ code: error.code }, 'socket event refused');
    }

    const body: SocketAck<never> = {
      ok: false,
      error: error ?? { code: 'internal', message: 'The server could not handle that event' },
    };

    if (ack === undefined) {
      host
        .switchToWs()
        .getClient<{ emit(event: string, payload: unknown): void }>()
        .emit('exception', body.error);
      return;
    }

    ack(body);
  }
}

/**
 * Nest calls a message handler as `(client, data, ack?, pattern)`, so the
 * acknowledgement is the one argument that is a function. Looking for it by
 * type rather than by position keeps this working whether or not the client
 * sent one.
 */
const ackOf = (args: readonly unknown[]): ((body: unknown) => void) | undefined =>
  args.find((argument): argument is (body: unknown) => void => typeof argument === 'function');

/** A `WsException` carrying the `SocketError` shape, or `null` for anything else. */
const socketErrorOf = (exception: unknown) => {
  if (!(exception instanceof WsException)) {
    return null;
  }

  const parsed = socketErrorSchema.safeParse(exception.getError());
  return parsed.success ? parsed.data : null;
};
