import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeyring } from './crypto.js';
import {
  type InvalidationHandler,
  RedisInvalidation,
  SETTINGS_INVALIDATION_CHANNEL,
} from './invalidation.js';
import type { SettingKey } from './registry.js';
import { createSettings, InMemorySettingsStore, type Settings } from './settings.js';

// Pinned to the image ARCHITECTURE §17 runs in production.
const REDIS_IMAGE = 'redis:7-alpine';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 4).toString('base64') });

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  // Written straight to stderr: Vitest drops console output from a file whose
  // suites are all skipped, and an operator who runs the integration project
  // without Docker deserves to be told why nothing ran.
  process.stderr.write(
    'Skipping the Redis integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const nextKey = (settings: Settings): Promise<SettingKey> =>
  new Promise((resolve) => {
    const handler: InvalidationHandler = (key) => {
      unsubscribe();
      resolve(key);
    };
    const unsubscribe = settings.subscribe(handler);
  });

describe.skipIf(!hasDocker)('settings invalidation over Redis', () => {
  let container: StartedRedisContainer;
  let writerChannel: RedisInvalidation;
  let readerChannel: RedisInvalidation;
  let raw: Redis;
  let writer: Settings;
  let reader: Settings;

  beforeAll(async () => {
    container = await new RedisContainer(REDIS_IMAGE).start();
    const url = container.getConnectionUrl();

    writerChannel = await RedisInvalidation.connect({ url });
    readerChannel = await RedisInvalidation.connect({ url });
    raw = new Redis(url);

    // One store stands in for the shared database the two replicas both read.
    const store = new InMemorySettingsStore();
    writer = createSettings({ env: {}, store, keyring, invalidation: writerChannel });
    reader = createSettings({ env: {}, store, keyring, invalidation: readerChannel });
  });

  afterAll(async () => {
    await writer?.close();
    await reader?.close();
    await raw?.quit();
    await writerChannel?.close();
    await readerChannel?.close();
    await container?.stop();
  });

  it('refreshes a second instance when the first writes a setting', async () => {
    await expect(reader.get('smtp.host')).resolves.toBe('');

    const delivered = nextKey(reader);
    await writer.set('smtp.host', 'smtp.example.com', { updatedBy: 'user-1' });

    await expect(delivered).resolves.toBe('smtp.host');
    await expect(reader.get('smtp.host')).resolves.toBe('smtp.example.com');
  });

  it('ignores a message on the channel that is not a settings key', async () => {
    const delivered = nextKey(reader);

    await raw.publish(SETTINGS_INVALIDATION_CHANNEL, 'smtp.nonsense');
    await writer.set('smtp.port', 2525, { updatedBy: 'user-1' });

    // The unknown key is acknowledged by the server before the real one is
    // sent, so it has already reached the subscriber by the time the assertion
    // below runs: only the filter can keep it out.
    await expect(delivered).resolves.toBe('smtp.port');
    await expect(reader.get('smtp.port')).resolves.toBe(2525);
  });
});
