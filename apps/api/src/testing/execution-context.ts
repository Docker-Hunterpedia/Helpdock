import type { ExecutionContext } from '@nestjs/common';

/**
 * Test scaffolding, not shipped: `tsconfig.json` keeps `src/testing` out of the
 * build. A guard needs an `ExecutionContext`, and building a real one means
 * booting Nest; these are the methods the guards actually call, for both
 * transports DOMAIN-RULES §1.3 names.
 */

export interface FakeExecutionContextOptions {
  /** The decorated handler, so `Reflector` finds its metadata. */
  readonly handler?: (...args: never[]) => unknown;
  readonly controller?: new (...args: never[]) => unknown;
  readonly request?: Record<string, unknown>;
  /** `'ws'` for a socket event, `'rpc'` to prove an unknown transport is refused. */
  readonly type?: 'http' | 'ws' | 'rpc';
  /** The socket, for a `'ws'` context. Its `data` carries the principal. */
  readonly client?: unknown;
  /** The message body, for a `'ws'` context. */
  readonly data?: unknown;
}

const noop = (): void => {};
class NoController {}

export const fakeExecutionContext = ({
  handler = noop,
  controller = NoController,
  request = {},
  type = 'http',
  client = {},
  data,
}: FakeExecutionContextOptions = {}): ExecutionContext =>
  ({
    getType: () => type,
    getHandler: () => handler,
    getClass: () => controller,
    getArgs: () => [client, data],
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => noop,
    }),
    switchToWs: () => ({
      getClient: () => client,
      getData: () => data,
      getPattern: () => 'test',
    }),
  }) as unknown as ExecutionContext;
