import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRawEmail } from '../inbound/parse-mime.js';
import {
  type ImapConnectOptions,
  ImapFailure,
  type ImapSettings,
  pollImapFolder,
  testImapConnection,
} from './imap-client.js';

/**
 * M2-02 against a real IMAP server: GreenMail, which speaks SMTP and IMAP and
 * holds its mailboxes in memory. Mail goes in over SMTP and comes out over
 * IMAPS, the path a real mailbox takes, so the cursor, the `\Seen` flag and the
 * sign-in failure are the server's and not a double's.
 */

const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.5';
const SMTP_PORT = 3025;
const IMAPS_PORT = 3993;
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write('Skipping the IMAP integration tests: Docker is not available.\n');
}

// GreenMail's certificate is self-signed. Only the suite says so.
const TEST_TLS: ImapConnectOptions = { tls: { rejectUnauthorized: false }, timeoutMs: 10_000 };

describe.skipIf(!hasDocker)('IMAP polling against GreenMail', () => {
  let container: StartedTestContainer;
  let settings: ImapSettings;

  const send = async (subject: string, extra: Record<string, string> = {}): Promise<void> => {
    const transport = nodemailer.createTransport({
      host: container.getHost(),
      port: container.getMappedPort(SMTP_PORT),
      secure: false,
      ignoreTLS: true,
    });
    await transport.sendMail({
      from: 'Mona <mona@example.com>',
      to: 'agent@helpdock.test',
      subject,
      text: `Body of ${subject}`,
      headers: extra,
    });
    transport.close();
  };

  beforeAll(async () => {
    container = await new GenericContainer(GREENMAIL_IMAGE)
      .withEnvironment({
        GREENMAIL_OPTS:
          '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=agent:secret@helpdock.test',
      })
      .withExposedPorts(SMTP_PORT, IMAPS_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(CONTAINER_STARTUP_MS)
      .start();

    settings = {
      host: container.getHost(),
      port: container.getMappedPort(IMAPS_PORT),
      security: 'tls',
      username: 'agent',
      password: 'secret',
      folder: 'INBOX',
    };
  });

  afterAll(async () => {
    await container?.stop();
  });

  it('counts the folder on Test IMAP and imports nothing', async () => {
    await send('Counted');

    const outcome = await testImapConnection(settings, TEST_TLS);

    expect(outcome.messages).toBeGreaterThanOrEqual(1);
    expect(outcome.unseen).toBe(outcome.messages);
  });

  it('reports a wrong password as a refused sign-in with the server’s answer', async () => {
    const failure = await testImapConnection({ ...settings, password: 'wrong' }, TEST_TLS).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ImapFailure);
    expect((failure as ImapFailure).kind).toBe('auth');
  });

  it('reports a folder that is not there', async () => {
    const failure = await testImapConnection({ ...settings, folder: 'Nope' }, TEST_TLS).catch(
      (error: unknown) => error,
    );

    expect((failure as ImapFailure).kind).toBe('folder');
  });

  it('imports the unseen messages once, then only what arrives after the cursor', async () => {
    const seen: string[] = [];
    const collect = async (raw: Buffer): Promise<void> => {
      seen.push((await parseRawEmail(raw)).subject);
    };

    const first = await pollImapFolder(
      settings,
      { uidValidity: null, lastUid: null },
      collect,
      TEST_TLS,
    );
    expect(first.imported).toBeGreaterThanOrEqual(1);
    expect(first.uidValidity).not.toBeNull();
    expect(first.handlerError).toBeNull();

    const again = await pollImapFolder(settings, first, collect, TEST_TLS);
    expect(again.imported).toBe(0);
    expect(again.lastUid).toBe(first.lastUid);

    await send('Later one');
    const later = await pollImapFolder(settings, again, collect, TEST_TLS);
    expect(later.imported).toBe(1);
    expect(seen.at(-1)).toBe('Later one');

    // Everything it took is `\Seen` now, so a fresh cursor finds nothing new.
    const fresh = await pollImapFolder(
      settings,
      { uidValidity: null, lastUid: null },
      collect,
      TEST_TLS,
    );
    expect(fresh.imported).toBe(0);
  });

  it('stops at a message the handler refused and keeps the cursor before it', async () => {
    const start = await pollImapFolder(
      settings,
      { uidValidity: null, lastUid: null },
      async () => undefined,
      TEST_TLS,
    );
    await send('Refused');
    await send('After refused');

    const refusal = new Error('database unavailable');
    const stopped = await pollImapFolder(settings, start, () => Promise.reject(refusal), TEST_TLS);

    expect(stopped.handlerError).toBe(refusal);
    expect(stopped.imported).toBe(0);
    expect(stopped.lastUid).toBe(start.lastUid ?? 0);

    const subjects: string[] = [];
    const retried = await pollImapFolder(
      settings,
      stopped,
      async (raw) => {
        subjects.push((await parseRawEmail(raw)).subject);
      },
      TEST_TLS,
    );
    expect(subjects).toEqual(['Refused', 'After refused']);
    expect(retried.imported).toBe(2);
  });

  it('skips a message over the size cap without downloading it', async () => {
    const start = await pollImapFolder(
      settings,
      { uidValidity: null, lastUid: null },
      async () => undefined,
      TEST_TLS,
    );
    await send('Too big');

    const skipped: number[] = [];
    const result = await pollImapFolder(
      settings,
      start,
      () => Promise.reject(new Error('must not be called')),
      { ...TEST_TLS, maxMessageBytes: 10, onSkipped: (uid) => skipped.push(uid) },
    );

    expect(skipped).toHaveLength(1);
    expect(result.imported).toBe(0);
    expect(result.handlerError).toBeNull();
  });
});
