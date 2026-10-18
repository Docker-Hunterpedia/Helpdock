import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IMPORT_SKIP_ENV, startImportInstall } from './import-install.js';

export default async function globalSetup() {
  const available = await promisify(execFile)(
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    { timeout: 60000 },
  ).then(
    () => true,
    () => false,
  );
  if (!available) {
    if (process.env.CI)
      throw new Error('Docker is required in CI for the real import browser tests.');
    process.env[IMPORT_SKIP_ENV] = '1';
    process.stderr.write('Skipping real import browser tests: Docker is unavailable.\n');
    return async () => {};
  }
  const install = await startImportInstall();
  return async () => {
    const errors: unknown[] = [];
    try {
      await install.stop();
    } catch (error) {
      errors.push(error);
    }
    if (install.failures.length)
      errors.push(new Error(`Import browser worker failures: ${install.failures.join(', ')}`));
    if (errors.length) throw new AggregateError(errors, 'Import browser teardown failed');
  };
}
