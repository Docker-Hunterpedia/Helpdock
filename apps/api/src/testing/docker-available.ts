import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const dockerAvailable = (): Promise<boolean> =>
  promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 60_000,
  }).then(
    () => true,
    (cause: unknown) => {
      if (process.env.CI)
        throw new Error(
          'Docker is required in CI; start the daemon and retry the database suites.',
          {
            cause,
          },
        );
      return false;
    },
  );
