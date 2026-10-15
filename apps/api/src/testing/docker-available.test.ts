import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { dockerAvailable } from './docker-available.js';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'helpdock-docker-probe-'));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each(['true', '1'])('refuses to skip required database tests when CI=%s', async (ci) => {
  await writeFile(path.join(directory, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  vi.stubEnv('PATH', directory);
  vi.stubEnv('CI', ci);
  await expect(dockerAvailable()).rejects.toThrow('Docker is required in CI');
});

it('allows a local developer without Docker to skip integration tests', async () => {
  await writeFile(path.join(directory, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  vi.stubEnv('PATH', directory);
  vi.stubEnv('CI', '');
  await expect(dockerAvailable()).resolves.toBe(false);
});

it('runs required database suites when the daemon answers', async () => {
  await writeFile(path.join(directory, 'docker'), '#!/bin/sh\necho 28.0.0\n', { mode: 0o700 });
  vi.stubEnv('PATH', directory);
  vi.stubEnv('CI', 'true');
  await expect(dockerAvailable()).resolves.toBe(true);
});
