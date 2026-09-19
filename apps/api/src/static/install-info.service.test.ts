import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.js';
import { InstallInfoService } from './install-info.service.js';

const env = { APP_URL: 'https://support.example.com' } as Env;
const logger = createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test' }, level: 'silent' });

describe('InstallInfoService', () => {
  it('falls back to the APP_URL host when the database is unreachable', async () => {
    const unreachable = {
      select: () => {
        throw new Error('connection refused');
      },
      // A double for one method of the pool; the failure path is the point.
    } as unknown as Db;

    // The sign-in screen must still render during an outage: an operator who
    // cannot see the form cannot see the outage either.
    await expect(new InstallInfoService(unreachable, env, logger).read()).resolves.toEqual({
      primaryDomain: 'support.example.com',
      brandCount: 1,
    });
  });
});
