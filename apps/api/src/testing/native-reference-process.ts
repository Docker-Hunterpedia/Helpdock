import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  type NativeReferenceWorkerConfig,
  nativeReferenceWorkerConfigSchema,
  nativeReferenceWorkerMessageSchema,
} from './native-reference-config.js';

/** Owns only the disposable import worker; never signals the developer's processes. */
export async function nativeReferenceProcess(input: NativeReferenceWorkerConfig) {
  const config = nativeReferenceWorkerConfigSchema.parse(input);
  const child = fork(new URL('./native-reference-worker.mjs', import.meta.url), [], {
    env: { NODE_ENV: 'test', PATH: process.env.PATH },
    execArgv: ['--max-old-space-size=384'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const failures: string[] = [];
  let stopping = false;
  let stderr = '';
  child.stdout?.resume();
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) failures.push(`worker exited (${code ?? signal ?? 'unknown'})`);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stopping = true;
      child.kill('SIGKILL');
      reject(new Error('Reference worker startup timed out'));
    }, 30000);
    const failed = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once('error', failed);
    child.once('exit', (code, signal) => {
      failed(new Error(`Reference worker exited before closing (${code ?? signal}): ${stderr}`));
    });
    child.on('message', (raw: unknown) => {
      const message = nativeReferenceWorkerMessageSchema.safeParse(raw);
      if (!message.success) {
        stopping = true;
        child.kill('SIGKILL');
        failed(new Error('Invalid reference worker IPC message'));
        return;
      }
      if (message.data.type === 'failed') {
        failures.push(`${message.data.job}:${message.data.error}`);
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
    child.send(config);
  });

  return {
    failures,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Reference worker already exited');
      stopping = true;
      const exited = once(child, 'exit');
      if (!child.kill('SIGKILL')) throw new Error('Could not kill the owned reference worker');
      const [, signal] = await exited;
      if (signal !== 'SIGKILL') throw new Error('Reference worker did not exit through SIGKILL');
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      const exited = once(child, 'exit');
      let forced = false;
      const timeout = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 10000);
      try {
        child.send({ type: 'close' });
        const [code] = await exited;
        if (forced || code !== 0) throw new Error('Reference worker failed to close cleanly');
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
