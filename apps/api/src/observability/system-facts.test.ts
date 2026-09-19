import { describe, expect, it } from 'vitest';
import { infoValue, postgresVersionNumber, readRedisFacts } from './system-facts.js';

describe('postgresVersionNumber', () => {
  it('takes the version out of the banner and leaves the build details behind', () => {
    expect(
      postgresVersionNumber(
        'PostgreSQL 17.6 (Debian 17.6-1.pgdg120+1) on aarch64-unknown-linux-gnu, compiled by gcc',
      ),
    ).toBe('17.6');
  });

  it.each([undefined, '', 'something else entirely'])('is null for %o', (banner) => {
    expect(postgresVersionNumber(banner)).toBeNull();
  });
});

describe('infoValue', () => {
  const info = [
    '# Server',
    'redis_version:7.4.2',
    'os:Linux',
    'aof_rewrite_in_progress:0',
    '',
  ].join('\r\n');

  it('reads a field by its exact name', () => {
    expect(infoValue(info, 'redis_version')).toBe('7.4.2');
    expect(infoValue(info, 'aof_rewrite_in_progress')).toBe('0');
  });

  it('does not match a field whose name merely ends the same way', () => {
    expect(infoValue(info, 'version')).toBeUndefined();
  });

  it('is undefined for a field Redis did not report', () => {
    expect(infoValue(info, 'nothing_like_this')).toBeUndefined();
  });
});

describe('readRedisFacts', () => {
  it('reports the version, the rewrite and how long the round trip took', async () => {
    const redis = {
      info: async (section: string) =>
        section === 'server' ? 'redis_version:7.4.2\r\n' : 'aof_rewrite_in_progress:1\r\n',
    };

    const facts = await readRedisFacts(redis as never);

    expect(facts).toMatchObject({
      reachable: true,
      version: '7.4.2',
      aofRewriteInProgress: true,
    });
    expect(facts.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a Redis it could not reach instead of throwing, so one gap is not a 500', async () => {
    const redis = {
      info: async () => {
        throw new Error('connection refused');
      },
    };

    expect(await readRedisFacts(redis as never)).toMatchObject({
      reachable: false,
      version: null,
      aofRewriteInProgress: false,
    });
  });
});
