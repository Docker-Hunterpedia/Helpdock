import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createKeyring, type Env } from '@helpdock/config';
import { createDb, users } from '@helpdock/db';
import {
  type AuthEmailPayload,
  authEmailJob,
  createJobProcessor,
  createOutboxDispatcher,
  createOutboxEventHandler,
  type JobLogger,
  type OutboxEventPayload,
  outboxEventJob,
  runRelayCycle,
} from '@helpdock/jobs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { InstallChannels } from '../notifications/install-channels.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { QueuedAuthMail } from '../testing/auth-mail.js';
import { createAuthEmailEventHandler, createAuthEmailProcessor } from './auth-email.job.js';
import { AUTH_EMAIL_EVENT } from './auth-email.js';

/**
 * Auth email end to end, against a real Postgres, Redis and Mailpit: the
 * request writes an `auth.email_requested` outbox row, the relay publishes it,
 * the outbox handler adds one `auth.email` job, and the job sends from the
 * install's system sender. What only the whole chain can prove:
 *
 * - a sign-in link, a password reset and an invitation each reach the inbox
 *   **exactly once**, however often the job is delivered;
 * - the link that arrives works;
 * - the token is in neither the outbox row nor any log line;
 * - without SMTP the job logs that it would have sent, and sends nothing.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const MAILPIT_IMAGE = 'axllent/mailpit';
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_HTTP_PORT = 8025;
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 23).toString('base64');
const APP_URL = 'https://support.example.com';
const CONTAINER_STARTUP_MS = 120_000;
const SYSTEM_FROM = 'no-reply@helpdock.test';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the auth email integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly From: { Address: string; Name: string };
  readonly To: { Address: string }[];
}

interface MailpitMessage {
  readonly Text: string;
  readonly HTML: string;
}

describe.skipIf(!hasDocker)('auth email delivery', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let mailpit: StartedTestContainer;
  let mailpitApi: string;
  let runtime: Runtime;
  let app: ApiApp;
  let seeded: SeededInstall;
  let queued: QueuedAuthMail;
  /** Every line the api and the job wrote. */
  const logLines: string[] = [];

  const jobLog: JobLogger = {
    info: (fields, message) => logLines.push(`${message} ${JSON.stringify(fields)}`),
    warn: (fields, message) => logLines.push(`${message} ${JSON.stringify(fields)}`),
    error: (fields, message) => logLines.push(`${message} ${JSON.stringify(fields)}`),
  };

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      DATABASE_MIGRATION_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const post = (path: string, body: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      payload: JSON.stringify(body),
    });

  const mailpitMessages = async (): Promise<MailpitSummary[]> => {
    const response = await fetch(`${mailpitApi}/api/v1/messages`);
    return ((await response.json()) as { messages: MailpitSummary[] }).messages;
  };

  const mailpitMessage = async (id: string): Promise<MailpitMessage> => {
    const response = await fetch(`${mailpitApi}/api/v1/message/${id}`);
    return (await response.json()) as MailpitMessage;
  };

  const useSystemSmtp = async (configured: boolean): Promise<void> => {
    const set = <K extends Parameters<Runtime['settings']['set']>[0]>(
      key: K,
      value: Parameters<Runtime['settings']['set']>[1],
    ) => runtime.settings.set(key, value as never, { updatedBy: 'integration-test' });

    await set('smtp.host', configured ? mailpit.getHost() : '');
    await set('smtp.port', mailpit.getMappedPort(MAILPIT_SMTP_PORT));
    await set('smtp.tls', 'none');
    await set('smtp.from', configured ? SYSTEM_FROM : '');
    await set('smtp.fromName', 'Helpdock');
  };

  /**
   * What the worker does after a request: one relay cycle, the `outbox.event`
   * consumer on each auth row, and the `auth.email` jobs those add. Returns the
   * jobs so a test can deliver them again.
   */
  const relayAuthEmails = async (): Promise<Job[]> => {
    const published: Job[] = [];
    await runRelayCycle({
      db: runtime.db,
      queue: {
        add: async (name, data, options) => {
          published.push({ name, data, id: options.jobId } as Job);
        },
      },
    });

    const added: Job[] = [];
    const dispatcher = createOutboxDispatcher();
    dispatcher.register(
      AUTH_EMAIL_EVENT,
      createAuthEmailEventHandler({
        add: async (jobId, payload) => {
          added.push({ name: authEmailJob.name, id: jobId, data: payload } as Job);
        },
      }),
    );
    const outboxEvent = createJobProcessor(outboxEventJob, createOutboxEventHandler(dispatcher), {
      db: runtime.db,
    });
    for (const job of published) {
      if ((job.data as OutboxEventPayload).event === AUTH_EMAIL_EVENT) {
        await outboxEvent(job);
      }
    }

    return added;
  };

  /** One delivery of an `auth.email` job, by the worker's own processor. */
  const deliver = (job: Job): Promise<void> =>
    createAuthEmailProcessor(
      { senders: new InstallChannels(runtime.settings), keyring: createKeyring(envFor()) },
      { db: runtime.db, log: jobLog },
    )(job);

  /** Each job twice in a row and twice at once: a redelivery and a race. */
  const deliverRepeatedly = async (jobs: readonly Job[]): Promise<void> => {
    for (const job of jobs) {
      await deliver(job);
      await deliver(job);
      await Promise.all([deliver(job), deliver(job)]);
    }
  };

  /** The one message Mailpit holds for an address, with its body. */
  const onlyMessageTo = async (address: string) => {
    const messages = (await mailpitMessages()).filter((message) =>
      message.To.some((to) => to.Address === address),
    );
    expect(messages).toHaveLength(1);
    const [summary] = messages;
    if (summary === undefined) {
      throw new Error(`nothing reached ${address}`);
    }
    return { summary, body: await mailpitMessage(summary.ID) };
  };

  const expectNoLeak = async (token: string): Promise<void> => {
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(await queued.payloads())).not.toContain(token);
    expect(logLines.join('\n')).not.toContain(token);
  };

  beforeAll(async () => {
    [postgres, redisContainer, mailpit] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new GenericContainer(MAILPIT_IMAGE)
        .withExposedPorts(MAILPIT_SMTP_PORT, MAILPIT_HTTP_PORT)
        .withStartupTimeout(CONTAINER_STARTUP_MS)
        .start(),
    ]);
    mailpitApi = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(MAILPIT_HTTP_PORT))}`;

    const owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'debug',
        destination: {
          write: (line: string) => {
            logLines.push(line);
          },
        },
      }),
    });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    queued = new QueuedAuthMail({ db: runtime.db, keyring: createKeyring(envFor()) });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), mailpit?.stop()]);
  });

  beforeEach(async () => {
    await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });
    const keys = await runtime.redis.keys('auth:rate:*');
    if (keys.length > 0) {
      await runtime.redis.del(...keys);
    }
  });

  it('without SMTP, logs that the email would have been sent and sends nothing', async () => {
    await useSystemSmtp(false);
    logLines.length = 0;

    expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);
    const jobs = await relayAuthEmails();
    expect(jobs).toHaveLength(1);
    await deliverRepeatedly(jobs);

    expect(await mailpitMessages()).toEqual([]);
    const wouldHave = logLines.filter((line) =>
      line.includes('Auth email not sent: this install has no SMTP settings'),
    );
    expect(wouldHave).toHaveLength(1);
    expect(wouldHave[0]).toContain(seeded.userId);
    await expectNoLeak((await queued.last()).text.match(/magic-link\/([A-Za-z0-9_-]+)/)?.[1] ?? '');
  });

  it('delivers a sign-in link once, however often the job arrives, and the link works', async () => {
    await useSystemSmtp(true);
    logLines.length = 0;

    expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);
    await deliverRepeatedly(await relayAuthEmails());

    const { summary, body } = await onlyMessageTo(seeded.email);
    expect(summary.From.Address).toBe(SYSTEM_FROM);
    const link = body.Text.match(/https:\/\/\S+\/api\/auth\/magic-link\/([A-Za-z0-9_-]+)/);
    const token = link?.[1] ?? '';
    await expectNoLeak(token);

    const followed = await app.inject({ method: 'GET', url: `/api/auth/magic-link/${token}` });
    expect(followed.statusCode).toBe(302);
    expect(followed.headers.location).not.toContain('error=');
  });

  it('delivers a password reset once, in the recipient language, and the token resets', async () => {
    await useSystemSmtp(true);
    await runtime.db.update(users).set({ locale: 'ar' }).where(eq(users.id, seeded.userId));
    logLines.length = 0;

    expect((await post('/api/auth/password/forgot', { email: seeded.email })).statusCode).toBe(204);
    await deliverRepeatedly(await relayAuthEmails());

    const { body } = await onlyMessageTo(seeded.email);
    expect(body.HTML).toContain('dir="rtl"');
    const token = decodeURIComponent(
      body.Text.match(/\/sign-in\/reset\?token=([^\s]+)/)?.[1] ?? '',
    );
    await expectNoLeak(token);

    const reset = await post('/api/auth/password/reset', { token, password: seeded.password });
    expect(reset.statusCode).toBe(204);
    await runtime.db.update(users).set({ locale: 'en' }).where(eq(users.id, seeded.userId));
  });

  it('delivers an invitation once, naming the brand, and the invitation opens', async () => {
    await useSystemSmtp(true);
    const signedIn = await post('/api/auth/sign-in', {
      email: seeded.email,
      password: seeded.password,
    });
    const accessToken = (signedIn.json() as { accessToken?: string }).accessToken ?? '';
    const invitee = `new-agent-${String(Date.now())}@helpdock.test`;
    logLines.length = 0;

    const invited = await post(
      `/api/brands/${seeded.brandId}/staff/invites`,
      { email: invitee, role: 'agent', departmentIds: [] },
      accessToken,
    );
    expect(invited.statusCode).toBe(201);
    await deliverRepeatedly(await relayAuthEmails());

    const { summary, body } = await onlyMessageTo(invitee);
    expect(summary.From.Address).toBe(SYSTEM_FROM);
    const token = body.Text.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
    await expectNoLeak(token);

    const preview = await app.inject({ method: 'GET', url: `/api/auth/invites/${token}` });
    expect(preview.statusCode).toBe(200);
  });

  it('keeps the job payload sealed in Redis too', async () => {
    await useSystemSmtp(true);
    expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);

    const [job] = await relayAuthEmails();
    const payload = job?.data as AuthEmailPayload;
    const token =
      (await queued.last()).text.match(/magic-link\/([A-Za-z0-9_-]+)/)?.[1] ?? 'missing';

    expect(payload.urlEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(job?.data)).not.toContain(token);
  });
});
