import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CaptchaTransport } from '@helpdock/channels';
import type { Env } from '@helpdock/config';
import {
  attachments,
  auditLog,
  brands,
  contactDuplicateSuggestions,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  departments,
  emailDeliveries,
  hcArticles,
  hcArticleVersions,
  hcCategories,
  hcSections,
  outbox,
  ticketActivity,
  ticketMessages,
  tickets,
  uuidv7,
  webFormSettings,
  withSystem,
} from '@helpdock/db';
import { outboxEvents, silentLogger } from '@helpdock/jobs';
import type { WebFormSettings, WebFormSettingsUpdate } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import type { BrandResolver } from '../context/brand-resolver.js';
import { AutoReplyService } from '../email/auto-reply.service.js';
import { EmailRepository } from '../email/email.repository.js';
import { registerEmailEventHandlers } from '../email/email-events.js';
import { OutboundEmailService } from '../email/outbound-email.service.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { FakeStorage } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M4-09 against a real Postgres and a real Redis, over HTTP as a browser posts.
 *
 * 1. A submission files a `form` ticket with its contact, message, custom
 *    fields and attachments, through the outbox like every other channel, and
 *    the auto-responder acknowledges it by email.
 * 2. The typed address is a claim: a second contact and a duplicate suggestion,
 *    never somebody else's history.
 * 3. CAPTCHA is enforced when on, and nothing is written when it fails.
 * 4. The per-IP and per-address limits apply.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const APP_URL = 'https://desk.example.com';
const HELP_HOST = 'help.example.com';
const GOOD_TOKEN = 'a-token-the-provider-accepts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
  'base64',
);

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the web form integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Posted {
  readonly status: number;
  readonly html: string;
  readonly csp: string;
}

describe.skipIf(!hasDocker)('the hosted web form', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let token: string;
  let billing: string;
  let bucket: string;
  const verified: string[] = [];
  let ipCounter = 10;

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

  const nextIp = (): string => {
    ipCounter += 1;
    return `203.0.113.${String(ipCounter)}`;
  };

  const api = async <T>(
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const response = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return { status: response.statusCode, body: response.json() as T };
  };

  const formPath = (): string => `/contact/${seeded.brandId}`;
  const settingsPath = (): string => `/api/brands/${seeded.brandId}/web-form`;

  const saveForm = async (changes: Partial<WebFormSettingsUpdate>): Promise<WebFormSettings> => {
    const current = await api<WebFormSettings>('GET', settingsPath());
    const response = await api<WebFormSettings>('PUT', settingsPath(), {
      enabled: current.body.enabled,
      departmentId: current.body.departmentId,
      captchaEnabled: current.body.captcha.enabled,
      thankYou: current.body.thankYou,
      fields: current.body.fields.map(({ field, shown, required }) => ({ field, shown, required })),
      ...changes,
    });
    expect(response.status).toBe(200);
    return response.body;
  };

  const post = async (
    fields: Record<string, string | readonly string[]>,
    options: {
      readonly url?: string;
      readonly host?: string;
      readonly ip?: string;
      readonly files?: readonly File[];
    } = {},
  ): Promise<Posted> => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of typeof value === 'string' ? [value] : value) {
        form.append(name, item);
      }
    }
    for (const file of options.files ?? []) {
      form.append('attachments', file);
    }
    const request = new Request('http://form.test', { method: 'POST', body: form });
    const response = await app.inject({
      method: 'POST',
      url: options.url ?? formPath(),
      remoteAddress: options.ip ?? nextIp(),
      headers: {
        'content-type': request.headers.get('content-type') ?? '',
        ...(options.host === undefined ? {} : { host: options.host }),
      },
      payload: Buffer.from(await request.arrayBuffer()),
    });
    return {
      status: response.statusCode,
      html: response.body,
      csp: String(response.headers['content-security-policy'] ?? ''),
    };
  };

  const referenceIn = (html: string): string => {
    const match = /<bdi class="mono">([A-Z]+-\d+)<\/bdi>/.exec(html);
    if (match?.[1] === undefined) {
      throw new Error(`no reference on the page: ${html.slice(0, 400)}`);
    }
    return match[1];
  };

  const ticketFor = async (reference: string) => {
    const number = Number(reference.split('-').at(-1));
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(tickets).where(eq(tickets.number, number)),
    );
    const ticket = rows[0];
    if (ticket === undefined) {
      throw new Error(`no ticket ${reference}`);
    }
    return ticket;
  };

  /** The unpublished outbox, and `email.received` dispatched as the worker would. */
  const drainOutbox = async (): Promise<string[]> => {
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`).orderBy(outbox.id),
    );
    for (const row of rows.filter((candidate) => candidate.event === 'email.received')) {
      await withSystem(runtime.db, row.brandId, async (tx) => {
        await outboxEvents.dispatch({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        });
        await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
      });
    }
    return rows.map((row) => row.event);
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    bucket = await mkdtemp(path.join(tmpdir(), 'helpdock-web-form-'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    const brandResolver: BrandResolver = {
      resolve: async (host) =>
        host === HELP_HOST ? { brandId: seeded.brandId, kind: 'helpcenter' } : null,
    };
    const captchaTransport: CaptchaTransport = {
      postForm: async (url, form) => {
        verified.push(url);
        const success = form.get('response') === GOOD_TOKEN && form.get('secret') === 'secret-key';
        return { status: 200, body: JSON.stringify({ success }) };
      },
    };
    app = await createApiApp({
      runtime,
      brandResolver,
      objectStorage: new FakeStorage(bucket),
      webForm: { captchaTransport },
    });

    const repository = new EmailRepository();
    registerEmailEventHandlers({
      queue: { add: async () => undefined },
      autoReplies: new AutoReplyService(
        repository,
        new OutboundEmailService(repository, { read: async () => undefined }),
      ),
    });

    token = await signInForTest(app, { email: seeded.email, password: seeded.password });

    billing = (
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .insert(departments)
          .values({ brandId: seeded.brandId, name: 'Billing', sortOrder: 5 })
          .returning({ id: departments.id }),
      )
    )[0]?.id as string;

    for (const field of [
      { key: 'order_number', label: 'Order number', labelAr: 'رقم الطلب', type: 'text' },
      { key: 'product', label: 'Product', type: 'select', options: ['Desk', 'Widget'] },
      { key: 'internal_note', label: 'Internal note', type: 'text' },
    ]) {
      const created = await api('POST', `/api/brands/${seeded.brandId}/custom-fields`, {
        target: 'ticket',
        ...field,
      });
      expect(created.status).toBe(201);
    }

    await api('PUT', `/api/brands/${seeded.brandId}/email/outgoing/senders`, {
      defaultFrom: { name: 'Helpdock Support', address: 'support@helpdock.test' },
      departments: [],
    });
    const outgoing = await api<{ autoReplies: Record<string, { enabled: boolean }> }>(
      'GET',
      `/api/brands/${seeded.brandId}/email/outgoing`,
    );
    await api('PUT', `/api/brands/${seeded.brandId}/email/outgoing/auto-replies`, {
      ...outgoing.body.autoReplies,
      acknowledgment: { ...outgoing.body.autoReplies.acknowledgment, enabled: true },
    });
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
    await rm(bucket, { recursive: true, force: true });
  });

  it('answers 404 with "This form is closed" until an Admin turns it on', async () => {
    const page = await app.inject({ method: 'GET', url: formPath() });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('This form is closed');

    const settings = await api<WebFormSettings>('GET', settingsPath());
    expect(settings.body).toMatchObject({
      enabled: false,
      publicUrl: `${APP_URL}/contact/${seeded.brandId}`,
      departmentId: null,
      captcha: { enabled: false, ready: false, provider: null },
    });
    expect(settings.body.fields.map((field) => field.field)).toEqual([
      'name',
      'email',
      'subject',
      'message',
      'custom:order_number',
      'custom:product',
      'custom:internal_note',
    ]);
  });

  it('saves the layout, flags the shown custom fields and writes an audit row', async () => {
    const saved = await saveForm({
      enabled: true,
      departmentId: billing,
      fields: [
        { field: 'custom:product', shown: true, required: true },
        { field: 'name', shown: true, required: true },
        { field: 'email', shown: false, required: false },
        { field: 'subject', shown: true, required: false },
        { field: 'message', shown: true, required: true },
        { field: 'custom:order_number', shown: true, required: false },
        { field: 'custom:internal_note', shown: false, required: true },
      ],
    });

    expect(saved.fields.map((field) => [field.field, field.shown, field.required])).toEqual([
      ['custom:product', true, true],
      ['name', true, true],
      // Locked: shown and required whatever the request said.
      ['email', true, true],
      ['subject', true, false],
      ['message', true, true],
      ['custom:order_number', true, false],
      // Hidden, so not required either.
      ['custom:internal_note', false, false],
    ]);
    const audits = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'web_form.updated')),
    );
    expect(audits.at(-1)?.meta).toMatchObject({
      enabled: { from: false, to: true },
      departmentId: { from: null, to: billing },
      shownCustomFields: ['product', 'order_number'],
    });
  });

  it('refuses a layout that drops a built-in field or names a field nobody defined', async () => {
    const current = await api<WebFormSettings>('GET', settingsPath());
    const fields = current.body.fields.map(({ field, shown, required }) => ({
      field,
      shown,
      required,
    }));
    const base = {
      enabled: true,
      departmentId: billing,
      captchaEnabled: false,
      thankYou: current.body.thankYou,
    };

    expect(
      (
        await api('PUT', settingsPath(), {
          ...base,
          fields: fields.filter((f) => f.field !== 'email'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('PUT', settingsPath(), {
          ...base,
          fields: [...fields, { field: 'custom:nobody', shown: true, required: false }],
        })
      ).status,
    ).toBe(400);
  });

  it('files a form ticket with its contact, custom fields and attachment, and acknowledges it', async () => {
    const page = await app.inject({ method: 'GET', url: `${formPath()}?lang=ar` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('dir="rtl"');
    expect(page.body).toContain('رقم الطلب');
    expect(page.body).not.toContain('Internal note');
    const submission = /name="hd_submission" value="([^"]+)"/.exec(page.body)?.[1] ?? '';

    const sent = await post(
      {
        lang: 'ar',
        hd_submission: submission,
        name: 'Omar Khalil',
        email: 'Omar.K@Example.com',
        subject: 'Refund for order 8841',
        message: 'The refund never arrived.\n\nCan you check?',
        'custom:order_number': '8841',
        'custom:product': 'Widget',
        'custom:internal_note': 'ignored: the field is hidden',
      },
      { files: [new File([PNG], 'receipt.png', { type: 'image/png' })] },
    );

    expect(sent.status).toBe(200);
    expect(sent.html).toContain('رقم طلبك');
    const ticket = await ticketFor(referenceIn(sent.html));
    expect(ticket).toMatchObject({
      channel: 'form',
      departmentId: billing,
      subject: 'Refund for order 8841',
      custom: { order_number: '8841', product: 'Widget' },
    });

    const [contact] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, ticket.contactId ?? '')),
    );
    expect(contact).toMatchObject({ name: 'Omar Khalil', locale: 'ar' });
    const identities = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.contactId, contact?.id ?? '')),
    );
    expect(identities).toMatchObject([
      { kind: 'email', value: 'omar.k@example.com', verified: false, source: 'web.form' },
    ]);

    const [message] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticket.id)),
    );
    expect(message).toMatchObject({
      channel: 'form',
      authorType: 'contact',
      bodyHtml: '<p>The refund never arrived.</p><p>Can you check?</p>',
    });
    const files = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(attachments).where(eq(attachments.ticketId, ticket.id)),
    );
    expect(files).toMatchObject([
      { originalName: 'receipt.png', mime: 'image/png', status: 'pending' },
    ]);

    const events = await drainOutbox();
    expect(events).toEqual(
      expect.arrayContaining(['ticket.created', 'attachment.uploaded', 'email.received']),
    );
    const acks = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(emailDeliveries)
        .where(
          and(eq(emailDeliveries.ticketId, ticket.id), eq(emailDeliveries.kind, 'acknowledgment')),
        ),
    );
    expect(acks).toMatchObject([{ toAddress: 'omar.k@example.com', locale: 'ar' }]);

    // A second post of the same submission — a refresh, a double click — is the same ticket.
    const again = await post({
      hd_submission: submission,
      name: 'Omar Khalil',
      email: 'omar.k@example.com',
      subject: 'Refund for order 8841',
      message: 'The refund never arrived.',
      'custom:product': 'Widget',
    });
    expect(referenceIn(again.html)).toBe(referenceIn(sent.html));
  });

  it('treats the typed address as a claim: a second contact and a duplicate suggestion', async () => {
    const fields = {
      name: 'Mona',
      email: 'mona@example.com',
      subject: 'One',
      message: 'Hello',
      'custom:product': 'Desk',
    };
    const first = await ticketFor(referenceIn((await post(fields)).html));
    const second = await ticketFor(referenceIn((await post({ ...fields, subject: 'Two' })).html));

    expect(second.contactId).not.toBe(first.contactId);
    const suggestions = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(contactDuplicateSuggestions)
        .where(eq(contactDuplicateSuggestions.contactId, second.contactId ?? '')),
    );
    expect(suggestions).toMatchObject([{ otherContactId: first.contactId, reason: 'email' }]);
  });

  it('records the help center article "Still need help?" came from, when it is a public one (M5-08)', async () => {
    const [publicId, internalId] = [uuidv7(), uuidv7()];
    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [category] = await tx
        .insert(hcCategories)
        .values({ brandId: seeded.brandId, slug: 'orders', names: { en: 'Orders' } })
        .returning();
      const [section] = await tx
        .insert(hcSections)
        .values({
          brandId: seeded.brandId,
          categoryId: category?.id ?? '',
          slug: 'tracking',
          names: { en: 'Tracking' },
        })
        .returning();
      for (const [id, slug, visibility] of [
        [publicId, 'where-is-my-order', 'public'],
        [internalId, 'carrier-escalations', 'internal'],
      ] as const) {
        await tx
          .insert(hcArticles)
          .values({ id, brandId: seeded.brandId, sectionId: section?.id ?? '', slug });
        await tx.insert(hcArticleVersions).values({
          brandId: seeded.brandId,
          articleId: id,
          locale: 'en',
          status: 'published',
          visibility,
          title: slug,
          publishedTitle:
            slug === 'where-is-my-order' ? 'Where is my order?' : 'Carrier escalations',
          publishedAt: new Date(),
        });
      }
    });
    const page = await app.inject({ method: 'GET', url: `${formPath()}?article=${publicId}` });
    expect(page.body).toContain(`name="hd_article" value="${publicId}"`);

    const fields = {
      name: 'Lina',
      email: 'lina@example.com',
      subject: 'Late',
      message: 'Still waiting',
      'custom:product': 'Desk',
    };
    const fromPublic = await ticketFor(
      referenceIn((await post({ ...fields, hd_article: publicId })).html),
    );
    const fromInternal = await ticketFor(
      referenceIn((await post({ ...fields, hd_article: internalId })).html),
    );

    const lines = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(ticketActivity).where(eq(ticketActivity.action, 'ticket.source_article')),
    );
    expect(lines.map((line) => line.ticketId)).toEqual([fromPublic.id]);
    expect(lines[0]?.to).toEqual({
      articleId: publicId,
      title: 'Where is my order?',
      locale: 'en',
    });
    expect(lines.map((line) => line.ticketId)).not.toContain(fromInternal.id);
  });

  it('names every field that needs attention and files nothing', async () => {
    const before = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(tickets),
    );
    const sent = await post({ name: '', email: 'omar@example', message: '' });

    expect(sent.status).toBe(422);
    expect(sent.html).toContain('4 fields need attention');
    expect(sent.html).toContain('href="#wf-email"');
    expect(sent.html).toContain('value="omar@example"');
    const after = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(tickets),
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('serves /contact on the brand’s help center host and nowhere else', async () => {
    const onHost = await app.inject({
      method: 'GET',
      url: '/contact',
      headers: { host: HELP_HOST },
    });
    expect(onHost.statusCode).toBe(200);
    expect(onHost.body).toContain('action="/contact"');
    expect(onHost.body).toContain('href="/"');

    const elsewhere = await app.inject({
      method: 'GET',
      url: '/contact',
      headers: { host: 'other.test' },
    });
    expect(elsewhere.statusCode).toBe(404);

    const saved = await api<WebFormSettings>('GET', settingsPath());
    expect(saved.body.publicUrl).toBe(`${APP_URL}/contact/${seeded.brandId}`);
  });

  it('refuses a file type the brand does not take, and a filled honeypot', async () => {
    const fields = { email: 'x@example.com', name: 'X', message: 'Hi', 'custom:product': 'Desk' };
    const exe = await post(fields, {
      files: [new File([Buffer.from('MZ')], 'setup.exe', { type: 'application/x-msdownload' })],
    });
    expect(exe.status).toBe(422);
    expect(exe.html).toContain('One of the files is a type we cannot accept.');

    const bot = await post({ ...fields, hd_website: 'https://spam.example' });
    expect(bot.status).toBe(400);
  });

  // The keys are the brand's one set, saved on Channels › Widget (ADR 0003).
  const saveCaptchaKeys = async (siteKey: string, secret?: string): Promise<void> => {
    const response = await api('PUT', `/api/brands/${seeded.brandId}/widget/access`, {
      allowedOrigins: [],
      captchaEnabled: false,
      captchaProvider: 'turnstile',
      captchaSiteKey: siteKey,
      ...(secret === undefined ? {} : { captchaSecret: secret }),
    });
    expect(response.status).toBe(200);
  };

  it('enforces the CAPTCHA when it is on, with the keys of the Widget tab, and takes nothing without them', async () => {
    await saveForm({ captchaEnabled: true });
    const noKeys = await app.inject({ method: 'GET', url: formPath() });
    expect(noKeys.statusCode).toBe(503);
    expect(noKeys.body).toContain('This form is not available');

    await saveCaptchaKeys('site-key', 'secret-key');
    expect((await api<WebFormSettings>('GET', settingsPath())).body.captcha).toMatchObject({
      ready: true,
      provider: 'turnstile',
    });
    const page = await app.inject({ method: 'GET', url: formPath() });
    expect(page.body).toContain('class="cf-turnstile" data-sitekey="site-key"');
    expect(String(page.headers['content-security-policy'])).toContain("script-src 'nonce-");
    expect(String(page.headers['content-security-policy'])).toContain(
      'https://challenges.cloudflare.com',
    );
    expect(page.body).not.toContain('secret-key');

    const fields = {
      email: 'captcha@example.com',
      name: 'C',
      message: 'Hi',
      'custom:product': 'Desk',
    };
    const failed = await post({ ...fields, 'cf-turnstile-response': 'forged' });
    expect(failed.status).toBe(422);
    expect(failed.html).toContain('The security check did not pass');
    const filed = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(contactIdentities).where(eq(contactIdentities.value, 'captcha@example.com')),
    );
    expect(filed).toEqual([]);

    const passed = await post({ ...fields, 'cf-turnstile-response': GOOD_TOKEN });
    expect(passed.status).toBe(200);
    expect(verified.length).toBe(2);

    await saveForm({ captchaEnabled: false });
    await saveCaptchaKeys('');
  });

  it('limits one address to five tickets an hour, whatever the IP', async () => {
    const fields = {
      email: 'loop@example.com',
      name: 'L',
      message: 'Hi',
      'custom:product': 'Desk',
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await post(fields)).status).toBe(200);
    }
    const sixth = await post(fields);
    expect(sixth.status).toBe(429);
    expect(sixth.html).toContain('Too many messages from here');
  });

  it('limits one IP to ten submissions in fifteen minutes', async () => {
    const ip = nextIp();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sent = await post(
        {
          email: `ip-${String(attempt)}@example.com`,
          name: 'I',
          message: 'Hi',
          'custom:product': 'Desk',
        },
        { ip },
      );
      expect(sent.status).toBe(200);
    }
    const eleventh = await post(
      { email: 'ip-last@example.com', name: 'I', message: 'Hi', 'custom:product': 'Desk' },
      { ip },
    );
    expect(eleventh.status).toBe(429);
  });

  it('never serves one brand’s form on another brand’s help center host', async () => {
    const [other] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(brands).values({ name: 'Other', prefix: 'OTH' }).returning({ id: brands.id }),
    );
    await withSystem(runtime.db, other?.id ?? '', (tx) =>
      tx.insert(webFormSettings).values({ brandId: other?.id ?? '', enabled: true }),
    );

    const onItsOwnPath = await app.inject({ method: 'GET', url: `/contact/${other?.id ?? ''}` });
    expect(onItsOwnPath.statusCode).toBe(200);
    const crossed = await app.inject({
      method: 'GET',
      url: `/contact/${other?.id ?? ''}`,
      headers: { host: HELP_HOST },
    });
    expect(crossed.statusCode).toBe(404);
  });
});
