import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { createLogger, NestPinoLogger, requestLogger } from './logger.js';

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
  createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test' }, level: 'trace', destination: stream });

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

  it('logs at info in production and debug elsewhere', () => {
    expect(createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'production' } }).level).toBe('info');
    expect(createLogger({ env: { APP_ROLE: 'worker', NODE_ENV: 'development' } }).level).toBe(
      'debug',
    );
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
});

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
