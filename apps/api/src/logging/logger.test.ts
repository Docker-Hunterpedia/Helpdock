import type { Principal } from '@helpdock/schemas';
import {
  type ContextManager,
  context as otelContext,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from '@opentelemetry/api';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { createLogger, loggerOptions, NestPinoLogger, requestLogger } from './logger.js';

interface Line {
  readonly level: string;
  readonly msg: string;
  readonly [key: string]: unknown;
}

const collector = (): { lines: Line[]; stream: DestinationStream } => {
  const lines: Line[] = [];
  return {
    lines,
    stream: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Line);
      },
    },
  };
};

const loggerWith = (stream: DestinationStream) =>
  createLogger({
    env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'info' },
    level: 'trace',
    destination: stream,
  });

const contextFor = (): RequestContext =>
  new RequestContext({ requestId: 'req-42', method: 'GET', path: '/api/brands' });

describe('createLogger', () => {
  it('writes JSON with the level as a name and the role on every line', () => {
    const { lines, stream } = collector();

    loggerWith(stream).info('up');

    expect(lines[0]).toMatchObject({ level: 'info', role: 'api', msg: 'up' });
  });

  it('removes a credential that reached a log line by accident', () => {
    const { lines, stream } = collector();

    loggerWith(stream).info(
      {
        req: { headers: { authorization: 'Bearer secret', cookie: 'sid=1' } },
        password: 'hunter2',
      },
      'oops',
    );

    expect(JSON.stringify(lines[0])).not.toContain('secret');
    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
    expect(JSON.stringify(lines[0])).not.toContain('sid=1');
  });

  it('removes the statement and the values from a logged driver error', () => {
    const { lines, stream } = collector();
    const error = Object.assign(new Error('duplicate key'), {
      query: 'insert into users (email) values ($1)',
      parameters: ['victim@example.com'],
    });

    loggerWith(stream).error({ err: error }, 'request failed');

    const line = JSON.stringify(lines[0]);
    expect(line).toContain('duplicate key');
    expect(line).not.toContain('victim@example.com');
    expect(line).not.toContain('insert into users');
  });

  it('logs at the level LOG_LEVEL asked for, whatever the environment', () => {
    expect(
      createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'production', LOG_LEVEL: 'info' } }).level,
    ).toBe('info');
    expect(
      createLogger({ env: { APP_ROLE: 'worker', NODE_ENV: 'test', LOG_LEVEL: 'debug' } }).level,
    ).toBe('debug');
    expect(
      createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'production', LOG_LEVEL: 'warn' } }).level,
    ).toBe('warn');
  });

  it('lets an explicit level win, so a test can silence it', () => {
    const logger = createLogger({
      env: { APP_ROLE: 'api', NODE_ENV: 'production', LOG_LEVEL: 'info' },
      level: 'silent',
    });

    expect(logger.level).toBe('silent');
  });

  it('prettifies in development only, and never over a destination a caller gave it', () => {
    const { stream } = collector();

    // The option, not the output: a transport writes through a worker thread,
    // which a unit test should not be starting to learn one boolean.
    expect(
      loggerOptions({ env: { APP_ROLE: 'api', NODE_ENV: 'development', LOG_LEVEL: 'info' } })
        .transport,
    ).toMatchObject({ target: 'pino-pretty' });

    expect(
      loggerOptions({ env: { APP_ROLE: 'api', NODE_ENV: 'production', LOG_LEVEL: 'info' } })
        .transport,
    ).toBeUndefined();

    expect(
      loggerOptions({
        env: { APP_ROLE: 'api', NODE_ENV: 'development', LOG_LEVEL: 'info' },
        destination: stream,
      }).transport,
    ).toBeUndefined();
  });
});

describe('requestLogger', () => {
  it('carries the request id, and the brand id once one is known', () => {
    const { lines, stream } = collector();
    const logger = loggerWith(stream);
    const context = contextFor();

    runInRequestContext(context, () => {
      requestLogger(logger).info('before');
      context.targetBrandId = '01937f5e-7e53-7000-8000-00000000000a';
      requestLogger(logger).info('after');
    });

    expect(lines[0]).toMatchObject({ requestId: 'req-42', msg: 'before' });
    expect(lines[0]?.brandId).toBeUndefined();
    expect(lines[1]).toMatchObject({
      requestId: 'req-42',
      brandId: '01937f5e-7e53-7000-8000-00000000000a',
    });
  });

  it('falls back to the brand the host named', () => {
    const { lines, stream } = collector();
    const context = contextFor();
    context.hostBrandId = '01937f5e-7e53-7000-8000-00000000000b';

    runInRequestContext(context, () => {
      requestLogger(loggerWith(stream)).info('hello');
    });

    expect(lines[0]?.brandId).toBe('01937f5e-7e53-7000-8000-00000000000b');
  });

  it('binds nothing outside a request', () => {
    const { lines, stream } = collector();

    requestLogger(loggerWith(stream)).info('boot');

    expect(lines[0]?.requestId).toBeUndefined();
  });

  it('names the principal by id and never by anything that identifies a person', () => {
    const { lines, stream } = collector();
    const context = contextFor();
    const principal: Principal = {
      type: 'staff',
      id: '01937f5e-7e53-7000-8000-00000000000c',
      brands: {},
      installAdmin: true,
    };
    context.principal = principal;

    runInRequestContext(context, () => {
      requestLogger(loggerWith(stream)).info('hello');
    });

    // The exact set, so a field added to the principal has to be a decision:
    // `not.toContain('@')` would pass even if the whole principal were spread
    // in, because the staff shape has no email to begin with.
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
      ['level', 'msg', 'principalId', 'requestId', 'role', 'time'].sort(),
    );
    expect(lines[0]?.principalId).toBe('01937f5e-7e53-7000-8000-00000000000c');
  });

  it('carries no trace id while nothing is tracing', () => {
    const { lines, stream } = collector();

    runInRequestContext(contextFor(), () => {
      requestLogger(loggerWith(stream)).info('hello');
    });

    expect(lines[0]?.traceId).toBeUndefined();
    expect(lines[0]?.spanId).toBeUndefined();
  });

  it('carries the trace and the request id together, so one can be found from the other', () => {
    const { lines, stream } = collector();
    const span = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });

    // Without a context manager the OpenTelemetry API's `context.with` is a
    // no-op, so there would be no active span to find and the test would prove
    // nothing. The real one is installed by the SDK in `instrumentation.ts`.
    otelContext.setGlobalContextManager(synchronousContextManager());

    try {
      otelContext.with(trace.setSpan(otelContext.active(), span), () => {
        runInRequestContext(contextFor(), () => {
          requestLogger(loggerWith(stream)).info('hello');
        });
      });
    } finally {
      otelContext.disable();
    }

    expect(lines[0]).toMatchObject({
      requestId: 'req-42',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    });
  });
});

/**
 * The smallest thing that satisfies `ContextManager` for a synchronous call.
 * The SDK's real one is built on `AsyncLocalStorage`; this only has to survive
 * the one `with` above.
 */
const synchronousContextManager = (): ContextManager => {
  let active = ROOT_CONTEXT;

  return {
    active: () => active,
    with: (context, fn, thisArg, ...args) => {
      const previous = active;
      active = context;
      try {
        return fn.call(thisArg, ...args);
      } finally {
        active = previous;
      }
    },
    bind: (_context, target) => target,
    enable() {
      return this;
    },
    disable() {
      active = ROOT_CONTEXT;
      return this;
    },
  };
};

describe('NestPinoLogger', () => {
  it('routes every Nest level into the same stream', () => {
    const { lines, stream } = collector();
    const nest = new NestPinoLogger(loggerWith(stream));

    nest.log('a', 'RouterExplorer');
    nest.warn('b');
    nest.error('c');
    nest.debug('d');
    nest.verbose('e');
    nest.fatal('f');

    expect(lines.map((line) => line.level)).toEqual([
      'info',
      'warn',
      'error',
      'debug',
      'trace',
      'fatal',
    ]);
    expect(lines[0]?.context).toBe('RouterExplorer');
  });

  it('serialises a message that is not a string', () => {
    const { lines, stream } = collector();

    new NestPinoLogger(loggerWith(stream)).log({ mapped: 1 });

    expect(lines[0]?.msg).toBe('{"mapped":1}');
  });
});
