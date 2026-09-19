import type { ArgumentsHost } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testing/silent-logger.js';
import { AckExceptionFilter } from './ack-exception.filter.js';
import { socketRefusal } from './messages.js';

interface Emitted {
  readonly event: string;
  readonly payload: unknown;
}

const hostFor = (args: unknown[], emitted: Emitted[]): ArgumentsHost =>
  ({
    getArgs: () => args,
    switchToWs: () => ({
      getClient: () => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ event, payload });
        },
      }),
    }),
    // biome-ignore lint/suspicious/noExplicitAny: the filter uses these two methods.
  }) as any;

describe('AckExceptionFilter', () => {
  const client = { id: 's1' };

  it('answers a refusal through the acknowledgement the caller is awaiting', () => {
    const acked: unknown[] = [];
    const ack = (body: unknown) => acked.push(body);

    new AckExceptionFilter(silentLogger()).catch(
      socketRefusal('forbidden', 'That department is outside your scope'),
      hostFor([client, {}, ack, 'room:join'], []),
    );

    expect(acked).toEqual([
      { ok: false, error: { code: 'forbidden', message: 'That department is outside your scope' } },
    ]);
  });

  it('falls back to an exception event when the client sent no acknowledgement', () => {
    const emitted: Emitted[] = [];

    new AckExceptionFilter(silentLogger()).catch(
      socketRefusal('invalid_payload', 'nope'),
      hostFor([client, {}, 'presence:heartbeat'], emitted),
    );

    expect(emitted).toEqual([
      { event: 'exception', payload: { code: 'invalid_payload', message: 'nope' } },
    ]);
  });

  it('tells the client nothing about a bug, and logs it', () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');
    const acked: unknown[] = [];

    new AckExceptionFilter(logger).catch(
      new TypeError('cannot read properties of undefined'),
      hostFor([client, {}, (body: unknown) => acked.push(body), 'room:join'], []),
    );

    expect(acked).toEqual([
      { ok: false, error: { code: 'internal', message: 'The server could not handle that event' } },
    ]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('treats a WsException that is not a SocketError as a bug, not as a refusal', () => {
    const acked: { error: { code: string } }[] = [];

    new AckExceptionFilter(silentLogger()).catch(
      new WsException('something went wrong'),
      // biome-ignore lint/suspicious/noExplicitAny: the ack shape is asserted below.
      hostFor([client, {}, ((body: any) => acked.push(body)) as any, 'room:join'], []),
    );

    expect(acked[0]?.error.code).toBe('internal');
  });
});
