import { createLogger, type Logger } from '../logging/logger.js';

/**
 * A real pino logger that writes nothing. Tests that want to assert a warning
 * was emitted spy on it; tests that only need a logger to exist get silence
 * instead of a page of JSON in the run output.
 */
export const silentLogger = (): Logger =>
  createLogger({
    env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    level: 'silent',
  });
