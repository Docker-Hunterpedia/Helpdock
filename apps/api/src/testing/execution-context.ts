import type { ExecutionContext } from '@nestjs/common';

/**
 * Test scaffolding, not shipped: `tsconfig.json` keeps `src/testing` out of the
 * build. A guard needs an `ExecutionContext`, and building a real one means
 * booting Nest; these are the four methods the guards actually call.
 */

export interface FakeExecutionContextOptions {
  /** The decorated handler, so `Reflector` finds its metadata. */
  readonly handler?: (...args: never[]) => unknown;
  readonly controller?: new (...args: never[]) => unknown;
  readonly request?: Record<string, unknown>;
  /** `'ws'` or `'rpc'` to prove the guards leave non-HTTP contexts alone. */
  readonly type?: 'http' | 'ws' | 'rpc';
}

const noop = (): void => {};
class NoController {}

export const fakeExecutionContext = ({
  handler = noop,
  controller = NoController,
  request = {},
  type = 'http',
}: FakeExecutionContextOptions = {}): ExecutionContext =>
  ({
    getType: () => type,
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => noop,
    }),
  }) as unknown as ExecutionContext;
