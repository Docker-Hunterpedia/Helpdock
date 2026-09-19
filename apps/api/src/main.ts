import 'reflect-metadata';
import { loadEnv } from '@helpdock/config';
import { start } from './bootstrap.js';

/**
 * The process entry point for both roles: `APP_ROLE=api` serves HTTP,
 * `APP_ROLE=worker` drains queues. One image, one entry point, one difference
 * (ARCHITECTURE §3).
 *
 * `reflect-metadata` is imported first and by nothing else: Nest's dependency
 * injection reads the metadata the decorators emit, and a decorator that runs
 * before the polyfill is installed records nothing.
 */

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

const main = async (): Promise<void> => {
  const env = loadEnv();
  const { close } = await start(env);

  let closing = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      // A second signal while the first is still draining must not start a
      // second shutdown; an operator who means it sends SIGKILL.
      if (closing) {
        return;
      }
      closing = true;

      close().then(
        () => process.exit(0),
        (error: unknown) => {
          process.stderr.write(`Shutdown failed: ${String(error)}\n`);
          process.exit(1);
        },
      );
    });
  }
};

try {
  await main();
} catch (error) {
  // Boot failures happen before there is a logger worth trusting, and the
  // message is the whole point: an operator reads it and fixes `.env`.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
