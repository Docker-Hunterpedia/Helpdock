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

/**
 * How long a drain may take before the process gives up and exits non-zero.
 * `docker stop` sends SIGTERM and then SIGKILL after its grace period, and a
 * container killed mid-drain leaves no line saying why; this one does. The
 * Compose services allow a longer grace period than this, so the timeout is
 * always ours to report rather than Docker's to cut short.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

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

      const deadline = setTimeout(() => {
        process.stderr.write(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS} ms; exiting\n`);
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      // The timer must not be the reason the event loop stays alive; the
      // shutdown it guards is.
      deadline.unref();

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
