import type { SocketErrorCode } from '@helpdock/schemas';
import { WsException } from '@nestjs/websockets';
import type { z } from 'zod';

/**
 * Zod at every boundary, and a socket message is one: it arrives from a browser
 * over a connection that was authenticated once and has been open ever since.
 *
 * A refusal is a `WsException` carrying the `SocketError` shape, which
 * {@link ./ack-exception.filter.js AckExceptionFilter} hands back through the
 * event's acknowledgement.
 */

export const socketRefusal = (code: SocketErrorCode, message: string): WsException =>
  new WsException({ code, message });

/**
 * The parsed message, or a refusal the client can act on. The Zod issues are
 * deliberately not sent: a caller with a malformed message is a caller with a
 * bug, and the shape is in `packages/schemas` for it to read.
 */
export const parseMessage = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw socketRefusal('invalid_payload', 'That message does not match its schema');
  }

  return parsed.data;
};
