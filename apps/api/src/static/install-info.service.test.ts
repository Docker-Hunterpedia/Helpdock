import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logging/logger.js';
import { InstallInfoService } from './install-info.service.js';

const env = { APP_URL: 'https://support.example.com' } as Env;
const logger = createLogger({
  env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  level: 'silent',
});

describe('InstallInfoService', () => {
  it('falls back to the APP_URL host when the database is unreachable', async () => {
    const unreachable = {
      select: () => {
        throw new Error('connection refused');
      },
      // A double for one method of the pool; the failure path is the point.
    } as unknown as Db;

    // The sign-in screen must still render during an outage: an operator who
    // cannot see the form cannot see the outage either. And a database that
    // cannot be read is never reported as a fresh install, or an outage would
    // offer a stranger the chance to claim it.
    await expect(new InstallInfoService(unreachable, env, logger).read()).resolves.toMatchObject({
      primaryDomain: 'support.example.com',
      brandCount: 1,
      installState: 'configured',
    });
  });

  it('says so in the log, because withholding the wizard is otherwise a mystery', async () => {
    const unreachable = {
      select: () => {
        throw new Error('connection refused');
      },
    } as unknown as Db;
    const warn = vi.spyOn(logger, 'warn');

    await new InstallInfoService(unreachable, env, logger).read();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('configured install'),
    );
    warn.mockRestore();
  });

  it('tells the wizard a setup key is required without ever carrying the key', async () => {
    const unreachable = {
      select: () => {
        throw new Error('connection refused');
      },
    } as unknown as Db;
    const key = 'q6c2mW1zXk9vT3yRb0nLd8sF4hJ7pA5e';

    const withKey = await new InstallInfoService(
      unreachable,
      { ...env, HD_SETUP_TOKEN: key },
      logger,
    ).read();
    const withoutKey = await new InstallInfoService(unreachable, env, logger).read();

    expect(withKey.setupKeyRequired).toBe(true);
    expect(JSON.stringify(withKey)).not.toContain(key);
    expect(withoutKey.setupKeyRequired).toBe(false);
  });
});
