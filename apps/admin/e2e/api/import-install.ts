import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type ImportBrowserReady,
  importBrowserInstallSchema,
  importBrowserReadySchema,
} from '@helpdock/importers/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { z } from 'zod';

export const IMPORT_API_PORT = Number(process.env.HD_E2E_IMPORT_API_PORT ?? 3092);
export const IMPORT_WEB_PORT = Number(process.env.HD_E2E_IMPORT_WEB_PORT ?? 5286);
export const IMPORT_API_ORIGIN = `http://127.0.0.1:${IMPORT_API_PORT}`;
export const IMPORT_WEB_ORIGIN = `http://localhost:${IMPORT_WEB_PORT}`;
export const IMPORT_READY_ENV = 'HD_E2E_IMPORT_READY';
export const IMPORT_CONTROL_KEY_ENV = 'HD_E2E_IMPORT_CONTROL_KEY';
export const IMPORT_SKIP_ENV = 'HD_E2E_IMPORT_UNAVAILABLE';

const failedSchema = z.strictObject({ type: z.literal('failed'), error: z.string().max(200) });

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  let forced = false;
  const timeout = setTimeout(() => {
    forced = true;
    child.kill('SIGKILL');
  }, 15000);
  try {
    if (child.connected) child.send({ type: 'close' });
    else child.kill('SIGTERM');
    const [code] = await exited;
    if (forced || code !== 0) throw new Error('Import browser API did not close cleanly');
  } finally {
    clearTimeout(timeout);
  }
}

/** Each run owns its containers and process; the app is reached only over HTTP. */
export async function startImportInstall() {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedRedisContainer | undefined;
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  let stopping = false;
  const failures: string[] = [];
  const stop = async () => {
    stopping = true;
    const errors: unknown[] = [];
    try {
      if (child) await stopChild(child);
    } catch (error) {
      errors.push(error);
    }
    const closed = await Promise.allSettled([
      redis?.stop(),
      postgres?.stop(),
      directory ? rm(directory, { recursive: true, force: true }) : undefined,
    ]);
    for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, 'Import browser fixture cleanup failed');
  };
  try {
    postgres = await new PostgreSqlContainer('pgvector/pgvector:pg17')
      .withStartupTimeout(120000)
      .start();
    redis = await new RedisContainer('redis:7-alpine').withStartupTimeout(120000).start();
    directory = await mkdtemp(path.join(tmpdir(), 'helpdock-browser-import-'));
    const runtimeUrl = new URL(postgres.getConnectionUri());
    runtimeUrl.username = 'helpdock_app';
    runtimeUrl.password = 'browser-import-test';
    const controlKey = randomBytes(32).toString('hex');
    const input = importBrowserInstallSchema.parse({
      databaseUrl: runtimeUrl.toString(),
      migrationUrl: postgres.getConnectionUri(),
      redisUrl: redis.getConnectionUrl(),
      directory,
      controlKey,
      apiPort: IMPORT_API_PORT,
      webOrigin: IMPORT_WEB_ORIGIN,
    });
    child = fork(
      new URL('../../../api/src/testing/import-browser-harness.mjs', import.meta.url),
      [],
      {
        env: { NODE_ENV: 'test', PATH: process.env.PATH },
        execArgv: ['--max-old-space-size=768'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    const running = child;
    let stderr = '';
    running.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const ready = await new Promise<ImportBrowserReady>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Import browser API startup timed out')),
        120000,
      );
      const finish = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      running.once('error', finish);
      running.once('exit', (code, signal) => {
        if (!stopping) failures.push(`process-exit:${code ?? signal}`);
        finish(new Error(`Import browser API exited during startup: ${stderr}`));
      });
      running.on('message', (raw: unknown) => {
        const failure = failedSchema.safeParse(raw);
        if (failure.success) {
          failures.push(failure.data.error);
          finish(new Error(`Import browser fixture failed: ${failure.data.error}`));
          return;
        }
        const value = importBrowserReadySchema.safeParse(raw);
        if (!value.success) {
          failures.push('invalid-ipc');
          finish(new Error('Invalid import browser ready message'));
          return;
        }
        clearTimeout(timeout);
        resolve(value.data);
      });
      running.send(input);
    });
    process.env[IMPORT_READY_ENV] = JSON.stringify(ready);
    process.env[IMPORT_CONTROL_KEY_ENV] = controlKey;
    return { ready, failures, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Import browser startup and cleanup failed');
    }
    throw error;
  }
}
