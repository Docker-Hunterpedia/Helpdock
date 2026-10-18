import {
  brands,
  createDb,
  type DbHandle,
  departments,
  runMigrations,
  ticketMessages,
  ticketStatuses,
  tickets,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDocker, startPostgres } from '../testing/meta-install.js';
import { WidgetRepository } from './widget.repository.js';

/**
 * M4-04's queue position against a real Postgres, with M11's imported history
 * in the same department: an imported open chat is nobody waiting in the
 * widget until its customer writes in it live, and then it queues from that
 * message rather than from its historical creation date.
 */

const APP_ROLE_PASSWORD = 'widget-queue-tests';
const ACCOUNT_KEY = 'a'.repeat(64);
const BRAND = uuidv7();
const OPEN = uuidv7();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the widget queue integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the widget queue position', () => {
  let postgres: StartedPostgreSqlContainer;
  let owner: DbHandle;
  let app: DbHandle;
  let number = 0;
  const widget = new WidgetRepository();

  beforeAll(async () => {
    postgres = await startPostgres();
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const runtime = new URL(postgres.getConnectionUri());
    runtime.username = 'helpdock_app';
    runtime.password = APP_ROLE_PASSWORD;
    app = createDb({ url: runtime.toString(), max: 1 });
    await owner.db.insert(brands).values({ id: BRAND, name: 'Acme', prefix: 'ACME' });
    await owner.db.insert(ticketStatuses).values({
      id: OPEN,
      brandId: BRAND,
      name: 'Open',
      systemState: 'open',
      systemKey: 'open',
      isDefault: true,
      color: 'info',
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await postgres?.stop();
  });

  /** Each case queues in its own department, so no case sees another's chats. */
  const department = async (): Promise<string> => {
    const id = uuidv7();
    await owner.db.insert(departments).values({ id, brandId: BRAND, name: `Support ${id}` });
    return id;
  };

  const chat = async (
    departmentId: string,
    createdAt: string,
    imported?: { readonly at: string },
  ): Promise<string> => {
    const id = uuidv7();
    number += 1;
    await owner.db.insert(tickets).values({
      id,
      brandId: BRAND,
      departmentId,
      number,
      prefix: 'ACME',
      subject: 'Where is my order?',
      statusId: OPEN,
      channel: 'chat',
      createdAt: new Date(createdAt),
      ...(imported ? { importedAt: new Date(imported.at), importSource: 'zendesk' } : {}),
    });
    return id;
  };

  const customerMessage = async (
    ticketId: string,
    departmentId: string,
    options: { readonly seq: number; readonly at: string; readonly imported: boolean },
  ): Promise<void> => {
    await owner.db.insert(ticketMessages).values({
      brandId: BRAND,
      departmentId,
      ticketId,
      seq: options.seq,
      kind: 'public',
      authorType: 'contact',
      bodyHtml: '<p>Hello?</p>',
      bodyText: 'Hello?',
      channel: 'chat',
      importSourceAccountKey: options.imported ? ACCOUNT_KEY : null,
      createdAt: new Date(options.at),
    });
  };

  const positionOf = (ticketId: string) =>
    withSystem(app.db, BRAND, async (tx) => {
      const [entry] = await tx
        .select({ ticket: tickets, status: ticketStatuses })
        .from(tickets)
        .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
        .where(eq(tickets.id, ticketId));
      if (entry === undefined) throw new Error(`Missing ticket ${ticketId}`);
      return widget.queuePosition(tx, entry);
    });

  // Regression, 2026-10-18: after a migration a live visitor read "position
  // 300 in queue", behind every open imported chat of the department.
  it('leaves imported history that nobody continued out of the queue', async () => {
    const support = await department();
    const migration = { at: '2026-10-01T09:00:00Z' };
    const untouched = await chat(support, '2024-03-01T10:00:00Z', migration);
    const importedReplies = await chat(support, '2024-03-02T10:00:00Z', migration);
    await customerMessage(importedReplies, support, {
      seq: 1,
      at: '2024-03-02T10:05:00Z',
      imported: true,
    });
    await chat(support, '2026-10-18T10:00:00Z');
    const visitor = await chat(support, '2026-10-18T10:01:00Z');

    expect(await positionOf(visitor)).toBe(2);
    expect(await positionOf(untouched)).toBeNull();
  });

  it('queues a continued imported chat from its first live message', async () => {
    const support = await department();
    const first = await chat(support, '2026-10-18T10:00:00Z');
    const continued = await chat(support, '2024-03-01T10:00:00Z', { at: '2026-10-01T09:00:00Z' });
    await customerMessage(continued, support, {
      seq: 1,
      at: '2024-03-01T10:05:00Z',
      imported: true,
    });
    await customerMessage(continued, support, {
      seq: 2,
      at: '2026-10-18T10:02:00Z',
      imported: false,
    });
    const later = await chat(support, '2026-10-18T10:03:00Z');

    expect(await positionOf(first)).toBe(1);
    expect(await positionOf(continued)).toBe(2);
    expect(await positionOf(later)).toBe(3);
  });
});
