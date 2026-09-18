/**
 * Regenerates the Playwright screenshot baselines as Linux pixels, which is
 * what CI compares against. The browsers run inside the official Playwright
 * image; the Vite dev server stays on the host, because `node_modules` here is
 * built for this machine and would not load inside the container.
 *
 * `pnpm --filter @helpdock/admin e2e:baselines`
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble';
const PLAYWRIGHT_VERSION = '1.63.0';
const PORT = 5273;

const adminDir = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(adminDir, '../..');

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await fetch(url).then(
      () => true,
      () => false,
    );
    if (reachable) {
      return;
    }
    await delay(250);
  }

  throw new Error(`the dev server did not answer on ${url}`);
}

const devServer = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
  cwd: adminDir,
  env: { ...process.env, VITE_AUTH_API: 'mock' },
  stdio: 'inherit',
});

try {
  await waitForServer(`http://localhost:${PORT}`);

  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--ipc=host',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--volume',
      `${repoRoot}:/repo`,
      '--workdir',
      '/repo/apps/admin',
      '--env',
      `PLAYWRIGHT_BASE_URL=http://host.docker.internal:${PORT}`,
      PLAYWRIGHT_IMAGE,
      'npx',
      '--yes',
      `playwright@${PLAYWRIGHT_VERSION}`,
      'test',
      '--update-snapshots',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );

  if (result.error) {
    throw new Error(`could not start Docker: ${result.error.message}`);
  }

  process.exitCode = result.status ?? 1;
} finally {
  devServer.kill();
}
