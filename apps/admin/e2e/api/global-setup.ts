import { dockerIsAvailable, type RunningInstall, SKIP_ENV, startInstall } from './install.js';

/**
 * Brings the install up before the `api` project runs, and takes it down after.
 *
 * Without Docker there is nothing to bring up, so the run is marked as skipped
 * rather than failed: a contributor on a machine with no Docker should still be
 * able to run `pnpm e2e`, and should be told plainly why this one did nothing.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!(await dockerIsAvailable())) {
    process.env[SKIP_ENV] = '1';
    process.stderr.write(
      'Skipping the api browser tests: Docker is not available. Start Docker and re-run `pnpm --filter @helpdock/admin e2e:api`.\n',
    );

    return () => Promise.resolve();
  }

  let install: RunningInstall | undefined;
  install = await startInstall();

  return async () => {
    await install?.stop();
    install = undefined;
  };
}
