import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type DbHandle, type DbTransaction } from './client.js';
import { runMigrations } from './migrate.js';
import { APP_ROLE_NAME } from './roles.js';
import {
  accounts,
  attachments,
  brands,
  contactIdentities,
  contacts,
  customerSessions,
  customerSignInTokens,
  departments,
  ticketMessages,
  ticketParticipants,
  ticketStatuses,
  tickets,
} from './schema/index.js';
import { withCustomer, withSystem, withTenant } from './tenant.js';
import { uuidv7 } from './uuid.js';

/**
 * M21-01, ADR 0060, DOMAIN-RULES §1.6 "Customer principal". Every negative test
 * of the customer portal's security boundary, against real Postgres and the
 * real policies, before any screen exists to hide a mistake.
 *
 * The visibility rule itself is `customerSees` in `@helpdock/schemas`, tested
 * there. These tests hand the principal its facts directly, so what they prove
 * is the part that must not depend on the application: given those facts, which
 * rows the database returns.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the portal isolation tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const brandA = uuidv7();
const brandB = uuidv7();

type Visibility = 'own' | 'managers' | 'all';

interface Brand {
  readonly id: string;
  readonly support: string;
  readonly hr: string;
  readonly open: string;
  readonly spam: string;
  readonly acme: string;
  readonly other: string;
  readonly alice: string;
  readonly bob: string;
  readonly carol: string;
  readonly dave: string;
  readonly erin: string;
  readonly frank: string;
}

const newBrand = (id: string): Brand => ({
  id,
  support: uuidv7(),
  hr: uuidv7(),
  open: uuidv7(),
  spam: uuidv7(),
  acme: uuidv7(),
  other: uuidv7(),
  alice: uuidv7(),
  bob: uuidv7(),
  carol: uuidv7(),
  dave: uuidv7(),
  erin: uuidv7(),
  frank: uuidv7(),
});

const A = newBrand(brandA);
const B = newBrand(brandB);

let counter = 0;
const nextNumber = (): number => {
  counter += 1;
  return counter;
};

describe.skipIf(!hasDocker)('the customer principal (M21-01)', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;
  let owner: DbHandle;
  let db: Db;

  const t: Record<string, string> = {};

  /** What the portal's own code computes before it opens a transaction. */
  const customer = (
    brand: Brand,
    contactId: string,
    sees: 'own' | 'account',
    accountId: string | null,
    departmentIds: readonly string[] | 'all' = [brand.support],
  ) => ({ brandId: brand.id, contactId, accountId, sees, departmentIds });

  const ticketIdsFor = (facts: ReturnType<typeof customer>): Promise<string[]> =>
    withCustomer(db, facts, async (tx) =>
      (await tx.select({ id: tickets.id }).from(tickets)).map((row) => row.id),
    );

  const names = (ids: readonly string[]): string[] =>
    ids.map((id) => Object.entries(t).find(([, value]) => value === id)?.[0] ?? id).sort();

  /** A ticket as the system principal writes it. The triggers fill every portal column. */
  const seedTicket = async (
    key: string,
    brand: Brand,
    values: Partial<typeof tickets.$inferInsert> & { contactId: string | null },
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    await withSystem(db, brand.id, (tx) =>
      tx.insert(tickets).values({
        id,
        brandId: brand.id,
        departmentId: brand.support,
        number: nextNumber(),
        prefix: 'T',
        subject: key,
        statusId: brand.open,
        channel: 'email',
        ...values,
      }),
    );
  };

  const seedMessage = async (
    key: string,
    brand: Brand,
    ticketKey: string,
    kind: 'public' | 'note' | 'ai' | 'system',
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    await withSystem(db, brand.id, (tx) =>
      tx.insert(ticketMessages).values({
        id,
        brandId: brand.id,
        ticketId: t[ticketKey] ?? '',
        departmentId: brand.support,
        seq: nextNumber(),
        kind,
        authorType: kind === 'note' ? 'staff' : 'contact',
        bodyHtml: `<p>${key}</p>`,
        bodyText: key,
        channel: 'email',
      }),
    );
  };

  const seedAttachment = async (
    key: string,
    brand: Brand,
    ticketKey: string,
    messageKey: string | null,
    status: 'ready' | 'pending' = 'ready',
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    await withSystem(db, brand.id, (tx) =>
      tx.insert(attachments).values({
        id,
        brandId: brand.id,
        ticketId: t[ticketKey] ?? '',
        departmentId: brand.support,
        messageId: messageKey === null ? null : (t[messageKey] ?? null),
        uploaderType: 'staff',
        uploaderId: 'test',
        s3Key: `brands/${brand.id}/${key}`,
        originalName: `${key}.png`,
        mime: 'image/png',
        size: 12,
        kind: 'image',
        status,
      }),
    );
  };

  const setVisibility = (brand: Brand, visibility: Visibility): Promise<unknown> =>
    withSystem(db, brand.id, (tx) =>
      tx.update(accounts).set({ portalVisibility: visibility }).where(eq(accounts.id, brand.acme)),
    );

  const asAlice = (brand: Brand, sees: 'own' | 'account') =>
    customer(brand, brand.alice, sees, brand.acme);
  const asBob = (brand: Brand, sees: 'own' | 'account') =>
    customer(brand, brand.bob, sees, brand.acme);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations({
      migrationUrl: container.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    const url = `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
    app = createDb({ url });
    owner = createDb({ url: container.getConnectionUri() });
    db = app.db;

    await db.insert(brands).values([
      { id: brandA, name: 'Acme', prefix: 'ACME' },
      { id: brandB, name: 'Globex', prefix: 'GLOBEX' },
    ]);

    for (const brand of [A, B]) {
      await withSystem(db, brand.id, async (tx) => {
        await tx.insert(departments).values([
          { id: brand.support, brandId: brand.id, name: 'Support' },
          { id: brand.hr, brandId: brand.id, name: 'HR' },
        ]);
        await tx.insert(ticketStatuses).values([
          {
            id: brand.open,
            brandId: brand.id,
            name: 'Open',
            systemState: 'open',
            isDefault: true,
            color: 'info',
          },
          {
            id: brand.spam,
            brandId: brand.id,
            name: 'Spam',
            systemState: 'closed',
            isSystem: true,
            systemKey: 'spam',
            color: 'danger',
          },
        ]);
        await tx.insert(accounts).values([
          { id: brand.acme, brandId: brand.id, name: 'Acme GmbH' },
          { id: brand.other, brandId: brand.id, name: 'Other Ltd' },
        ]);
        await tx.insert(contacts).values([
          {
            id: brand.alice,
            brandId: brand.id,
            name: 'Alice',
            accountId: brand.acme,
            accountRole: 'manager',
          },
          { id: brand.bob, brandId: brand.id, name: 'Bob', accountId: brand.acme },
          { id: brand.carol, brandId: brand.id, name: 'Carol', accountId: brand.acme },
          { id: brand.dave, brandId: brand.id, name: 'Dave' },
          { id: brand.erin, brandId: brand.id, name: 'Erin', accountId: brand.other },
          { id: brand.frank, brandId: brand.id, name: 'Frank', accountId: brand.acme },
        ]);
        await tx.insert(contactIdentities).values(
          (['alice', 'bob', 'carol', 'dave', 'erin', 'frank'] as const).map((who) => ({
            brandId: brand.id,
            contactId: brand[who],
            kind: 'email' as const,
            value: `${who}@example.com`,
            // Frank has never proved his mailbox.
            verified: who !== 'frank',
            source: 'test',
          })),
        );
      });
    }

    // Brand A: the cast of every scenario.
    await seedTicket('bobTicket', A, { contactId: A.bob });
    await seedTicket('aliceTicket', A, { contactId: A.alice });
    await seedTicket('carolTicket', A, { contactId: A.carol });
    await seedTicket('carolPrivate', A, { contactId: A.carol, portalPrivate: true });
    await seedTicket('daveTicket', A, { contactId: A.dave });
    await seedTicket('erinTicket', A, { contactId: A.erin });
    await seedTicket('bobHr', A, { contactId: A.bob, departmentId: A.hr });
    await seedTicket('bobDeleted', A, { contactId: A.bob, deletedAt: new Date() });
    await seedTicket('bobSpam', A, { contactId: A.bob, statusId: A.spam });
    await seedTicket('bobMerged', A, { contactId: A.bob, mergedIntoId: t.bobTicket ?? null });
    await seedTicket('daveCcBob', A, { contactId: A.dave });
    await seedTicket('daveCcFrank', A, { contactId: A.dave });

    await withSystem(db, brandA, (tx) =>
      tx.insert(ticketParticipants).values([
        {
          brandId: brandA,
          ticketId: t.daveCcBob ?? '',
          departmentId: A.support,
          contactId: A.bob,
          address: 'bob@example.com',
          source: 'agent',
        },
        {
          brandId: brandA,
          ticketId: t.daveCcFrank ?? '',
          departmentId: A.support,
          contactId: A.frank,
          address: 'frank@example.com',
          source: 'agent',
        },
      ]),
    );

    await seedMessage('bobPublic', A, 'bobTicket', 'public');
    await seedMessage('bobNote', A, 'bobTicket', 'note');
    await seedMessage('bobAi', A, 'bobTicket', 'ai');
    await seedMessage('bobSystem', A, 'bobTicket', 'system');
    await seedAttachment('bobFile', A, 'bobTicket', 'bobPublic');
    await seedAttachment('bobNoteFile', A, 'bobTicket', 'bobNote');
    await seedAttachment('bobPendingFile', A, 'bobTicket', 'bobPublic', 'pending');
    await seedAttachment('bobUnlinkedFile', A, 'bobTicket', null);
    await seedMessage('aliceMessage', A, 'aliceTicket', 'public');
    await seedAttachment('aliceFile', A, 'aliceTicket', 'aliceMessage');
    await seedMessage('daveCcMessage', A, 'daveCcBob', 'public');
    await seedMessage('frankCcMessage', A, 'daveCcFrank', 'public');
    await seedMessage('carolPrivateMessage', A, 'carolPrivate', 'public');

    // Brand B: the same shape under the same names, which is the point.
    await seedTicket('bobTicketB', B, { contactId: B.bob });
    await seedMessage('bobPublicB', B, 'bobTicketB', 'public');
  });

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await container?.stop();
  });

  describe('which tickets a customer reads', () => {
    it('shows a requester their own tickets and nobody else’s, under the default', async () => {
      const visible = names(await ticketIdsFor(asBob(A, 'own')));

      expect(visible).toEqual(['bobTicket', 'daveCcBob']);
    });

    it('shows a customer with no account only what they asked for', async () => {
      expect(names(await ticketIdsFor(customer(A, A.dave, 'own', null)))).toEqual([
        'daveCcBob',
        'daveCcFrank',
        'daveTicket',
      ]);
    });

    it('shows a manager the account’s tickets, and a member only their own, under managers', async () => {
      await setVisibility(A, 'managers');

      const manager = names(await ticketIdsFor(asAlice(A, 'account')));
      const member = names(await ticketIdsFor(asBob(A, 'own')));

      // Alice sees the whole of Acme (Bob, Carol, Alice), except what is private.
      expect(manager).toEqual(['aliceTicket', 'bobTicket', 'carolTicket']);
      expect(member).toEqual(['bobTicket', 'daveCcBob']);
    });

    it('shows every member the account’s tickets under all', async () => {
      await setVisibility(A, 'all');

      expect(names(await ticketIdsFor(asBob(A, 'account')))).toEqual([
        'aliceTicket',
        'bobTicket',
        'carolTicket',
        // As a CC, whatever the company view says.
        'daveCcBob',
      ]);
    });

    it('never shows another company’s tickets, however much the account is shared', async () => {
      const visible = names(await ticketIdsFor(asBob(A, 'account')));

      expect(visible).not.toContain('erinTicket');
      expect(visible).not.toContain('daveTicket');
    });

    it('keeps a private ticket from coworkers but not from its requester', async () => {
      await setVisibility(A, 'all');

      expect(names(await ticketIdsFor(asBob(A, 'account')))).not.toContain('carolPrivate');
      expect(names(await ticketIdsFor(asAlice(A, 'account')))).not.toContain('carolPrivate');
      expect(names(await ticketIdsFor(customer(A, A.carol, 'account', A.acme)))).toContain(
        'carolPrivate',
      );
      // And not from a CC either.
      await withSystem(db, brandA, (tx) =>
        tx.insert(ticketParticipants).values({
          brandId: brandA,
          ticketId: t.carolPrivate ?? '',
          departmentId: A.support,
          contactId: A.bob,
          address: 'bob@example.com',
          source: 'agent',
        }),
      );
      expect(names(await ticketIdsFor(asBob(A, 'own')))).toContain('carolPrivate');
      await withSystem(db, brandA, (tx) =>
        tx.delete(ticketParticipants).where(eq(ticketParticipants.ticketId, t.carolPrivate ?? '')),
      );
      expect(names(await ticketIdsFor(asBob(A, 'own')))).not.toContain('carolPrivate');
    });

    it('shows a CC whose address is a verified identity of theirs, and not one who never proved it', async () => {
      expect(names(await ticketIdsFor(asBob(A, 'own')))).toContain('daveCcBob');
      expect(names(await ticketIdsFor(customer(A, A.frank, 'own', A.acme)))).toEqual([]);
    });

    it('follows a CC’s identity being verified, and being taken away again', async () => {
      const frank = customer(A, A.frank, 'own', A.acme);
      const identity = (verified: boolean) =>
        withSystem(db, brandA, (tx) =>
          tx
            .update(contactIdentities)
            .set({ verified })
            .where(eq(contactIdentities.contactId, A.frank)),
        );

      await identity(true);
      expect(names(await ticketIdsFor(frank))).toEqual(['daveCcFrank']);
      expect(
        names(
          await withCustomer(db, frank, async (tx) =>
            (await tx.select({ id: ticketMessages.id }).from(ticketMessages)).map((row) => row.id),
          ),
        ),
      ).toEqual(['frankCcMessage']);

      await identity(false);
      expect(names(await ticketIdsFor(frank))).toEqual([]);
    });

    it('follows a CC being removed', async () => {
      const participant = await withSystem(db, brandA, (tx) =>
        tx
          .insert(ticketParticipants)
          .values({
            brandId: brandA,
            ticketId: t.erinTicket ?? '',
            departmentId: A.support,
            contactId: A.carol,
            address: 'carol@example.com',
            source: 'agent',
          })
          .returning({ id: ticketParticipants.id }),
      );
      const carol = customer(A, A.carol, 'own', A.acme);
      expect(names(await ticketIdsFor(carol))).toContain('erinTicket');

      await withSystem(db, brandA, (tx) =>
        tx.delete(ticketParticipants).where(eq(ticketParticipants.id, participant[0]?.id ?? '')),
      );
      expect(names(await ticketIdsFor(carol))).not.toContain('erinTicket');
    });

    it('hides a ticket in a department the brand does not show, even from its requester', async () => {
      expect(names(await ticketIdsFor(asBob(A, 'own')))).not.toContain('bobHr');
      // And shows it once the brand shows that department.
      expect(
        names(await ticketIdsFor(customer(A, A.bob, 'own', A.acme, [A.support, A.hr]))),
      ).toContain('bobHr');
      expect(names(await ticketIdsFor(customer(A, A.bob, 'own', A.acme, 'all')))).toContain(
        'bobHr',
      );
    });

    it('shows nothing when the brand shows no department at all', async () => {
      expect(await ticketIdsFor(customer(A, A.bob, 'own', A.acme, []))).toEqual([]);
    });

    it('hides deleted, spam and merged-away tickets from their requester', async () => {
      const visible = names(await ticketIdsFor(asBob(A, 'own')));

      expect(visible).not.toContain('bobDeleted');
      expect(visible).not.toContain('bobSpam');
      expect(visible).not.toContain('bobMerged');
    });

    it('hides a ticket the moment it is deleted, marked spam or merged, and shows it again when it is not', async () => {
      await seedTicket('transient', A, { contactId: A.bob });
      const bob = asBob(A, 'own');
      const set = (values: Partial<typeof tickets.$inferInsert>) =>
        withSystem(db, brandA, (tx) =>
          tx
            .update(tickets)
            .set(values)
            .where(eq(tickets.id, t.transient ?? '')),
        );

      expect(names(await ticketIdsFor(bob))).toContain('transient');
      await set({ deletedAt: new Date() });
      expect(names(await ticketIdsFor(bob))).not.toContain('transient');
      await set({ deletedAt: null });
      expect(names(await ticketIdsFor(bob))).toContain('transient');
      await set({ statusId: A.spam });
      expect(names(await ticketIdsFor(bob))).not.toContain('transient');
      await set({ statusId: A.open });
      expect(names(await ticketIdsFor(bob))).toContain('transient');
      await set({ mergedIntoId: t.bobTicket ?? null });
      expect(names(await ticketIdsFor(bob))).not.toContain('transient');
      await set({ mergedIntoId: null });
      expect(names(await ticketIdsFor(bob))).toContain('transient');
    });

    it('does not widen what the department policy gives a customer', async () => {
      // The permissive department policy is still in force beside the customer
      // one: a department list that omits a department hides it whatever the
      // customer's own predicate says.
      const rows = await withCustomer(db, customer(A, A.bob, 'own', A.acme, [uuidv7()]), (tx) =>
        tx.select({ id: tickets.id }).from(tickets),
      );

      expect(rows).toEqual([]);
    });
  });

  describe('the account and the ticket follow the requester', () => {
    it('fills account_id when a ticket is made, whatever the caller passed', async () => {
      await seedTicket('lied', A, { contactId: A.bob, accountId: A.other });

      const [row] = await withSystem(db, brandA, (tx) =>
        tx
          .select({ accountId: tickets.accountId })
          .from(tickets)
          .where(eq(tickets.id, t.lied ?? '')),
      );

      expect(row?.accountId).toBe(A.acme);
    });

    it('moves the old account’s members out and the new account’s in when the contact moves', async () => {
      await setVisibility(A, 'all');
      await withSystem(db, brandA, (tx) =>
        tx.update(accounts).set({ portalVisibility: 'all' }).where(eq(accounts.id, A.other)),
      );
      const erin = customer(A, A.erin, 'account', A.other);
      const bob = asBob(A, 'account');
      expect(names(await ticketIdsFor(erin))).toEqual(['erinTicket']);
      expect(names(await ticketIdsFor(bob))).not.toContain('erinTicket');

      // Staff move Erin into Acme.
      await withSystem(db, brandA, (tx) =>
        tx.update(contacts).set({ accountId: A.acme }).where(eq(contacts.id, A.erin)),
      );

      expect(names(await ticketIdsFor(bob))).toContain('erinTicket');
      // The old account's remaining members no longer see it; Erin, now in Acme, does.
      expect(names(await ticketIdsFor(customer(A, A.erin, 'account', A.acme)))).toContain(
        'bobTicket',
      );
      expect(names(await ticketIdsFor(customer(A, A.erin, 'account', A.other)))).not.toContain(
        'bobTicket',
      );

      // And back out.
      await withSystem(db, brandA, (tx) =>
        tx.update(contacts).set({ accountId: A.other }).where(eq(contacts.id, A.erin)),
      );
      expect(names(await ticketIdsFor(bob))).not.toContain('erinTicket');
    });

    it('takes the messages and attachments along with the ticket when the contact moves', async () => {
      await setVisibility(A, 'all');
      await seedTicket('movable', A, { contactId: A.erin });
      await seedMessage('movableMessage', A, 'movable', 'public');
      await seedAttachment('movableFile', A, 'movable', 'movableMessage');
      const rowsOf = (facts: ReturnType<typeof customer>) =>
        withCustomer(db, facts, async (tx) => ({
          messages: (await tx.select({ id: ticketMessages.id }).from(ticketMessages)).map(
            (row) => row.id,
          ),
          files: (await tx.select({ id: attachments.id }).from(attachments)).map((row) => row.id),
        }));
      const bob = asBob(A, 'account');

      expect((await rowsOf(bob)).messages).not.toContain(t.movableMessage);
      await withSystem(db, brandA, (tx) =>
        tx.update(contacts).set({ accountId: A.acme }).where(eq(contacts.id, A.erin)),
      );
      const moved = await rowsOf(bob);
      expect(moved.messages).toContain(t.movableMessage);
      expect(moved.files).toContain(t.movableFile);

      await withSystem(db, brandA, (tx) =>
        tx.update(contacts).set({ accountId: A.other }).where(eq(contacts.id, A.erin)),
      );
      const back = await rowsOf(bob);
      expect(back.messages).not.toContain(t.movableMessage);
      expect(back.files).not.toContain(t.movableFile);
    });

    it('follows the ticket’s contact being changed', async () => {
      await setVisibility(A, 'all');
      await seedTicket('reassigned', A, { contactId: A.erin });
      const bob = asBob(A, 'account');
      expect(names(await ticketIdsFor(bob))).not.toContain('reassigned');

      await withSystem(db, brandA, (tx) =>
        tx
          .update(tickets)
          .set({ contactId: A.carol })
          .where(eq(tickets.id, t.reassigned ?? '')),
      );

      const [row] = await withSystem(db, brandA, (tx) =>
        tx
          .select({ accountId: tickets.accountId })
          .from(tickets)
          .where(eq(tickets.id, t.reassigned ?? '')),
      );
      expect(row?.accountId).toBe(A.acme);
      expect(names(await ticketIdsFor(bob))).toContain('reassigned');
      expect(names(await ticketIdsFor(customer(A, A.erin, 'own', A.other)))).not.toContain(
        'reassigned',
      );
    });

    it('drops the account from a ticket when the account is deleted', async () => {
      const doomedAccount = uuidv7();
      const doomedContact = uuidv7();
      await withSystem(db, brandA, async (tx) => {
        await tx.insert(accounts).values({ id: doomedAccount, brandId: brandA, name: 'Doomed' });
        await tx.insert(contacts).values({
          id: doomedContact,
          brandId: brandA,
          name: 'Gus',
          accountId: doomedAccount,
        });
      });
      await seedTicket('doomedTicket', A, { contactId: doomedContact });
      await withSystem(db, brandA, async (tx) => {
        await tx.insert(contactIdentities).values({
          brandId: brandA,
          contactId: doomedContact,
          kind: 'email',
          value: 'gus@example.com',
          verified: true,
          source: 'test',
        });
        await tx.delete(accounts).where(eq(accounts.id, doomedAccount));
      });

      const [row] = await withSystem(db, brandA, (tx) =>
        tx
          .select({ accountId: tickets.accountId })
          .from(tickets)
          .where(eq(tickets.id, t.doomedTicket ?? '')),
      );
      expect(row?.accountId).toBeNull();
    });

    it('is not fooled by a manager of an account the contact has left', async () => {
      await withSystem(db, brandA, (tx) =>
        tx.update(accounts).set({ portalVisibility: 'all' }).where(eq(accounts.id, A.acme)),
      );
      // Facts that still claim the old account: the ticket's own account_id is
      // what the policy compares, so a stale claim reads the old company's
      // tickets only while the tickets are still there. Here it is another
      // company's id, which matches nothing.
      const stale = customer(A, A.alice, 'account', A.other);
      const visible = names(await ticketIdsFor(stale));

      expect(visible).toContain('erinTicket');
      // Alice still sees what she asked for herself, and nothing of Acme's.
      expect(visible).not.toContain('bobTicket');
      expect(visible).not.toContain('carolTicket');
    });
  });

  describe('which messages and files a customer reads', () => {
    const rowsOf = (facts: ReturnType<typeof customer>) =>
      withCustomer(db, facts, async (tx) => ({
        messages: names(
          (await tx.select({ id: ticketMessages.id }).from(ticketMessages)).map((row) => row.id),
        ),
        files: names(
          (await tx.select({ id: attachments.id }).from(attachments)).map((row) => row.id),
        ),
      }));

    it('shows public and AI messages and never a note or a system line', async () => {
      const { messages } = await rowsOf(asBob(A, 'own'));

      expect(messages).toContain('bobPublic');
      expect(messages).toContain('bobAi');
      expect(messages).not.toContain('bobNote');
      expect(messages).not.toContain('bobSystem');
    });

    it('shows a file of a public message only once it is ready, and never one of a note or of no message', async () => {
      const { files } = await rowsOf(asBob(A, 'own'));

      expect(files).toContain('bobFile');
      expect(files).not.toContain('bobNoteFile');
      expect(files).not.toContain('bobPendingFile');
      expect(files).not.toContain('bobUnlinkedFile');
    });

    it('shows a CC the thread of the ticket they are on', async () => {
      const { messages } = await rowsOf(asBob(A, 'own'));

      expect(messages).toContain('daveCcMessage');
      expect(messages).not.toContain('frankCcMessage');
    });

    it('shows a coworker’s thread only where the company view reaches it', async () => {
      await setVisibility(A, 'own');
      expect((await rowsOf(asBob(A, 'own'))).messages).not.toContain('aliceMessage');

      await setVisibility(A, 'all');
      const open = await rowsOf(asBob(A, 'account'));
      expect(open.messages).toContain('aliceMessage');
      expect(open.files).toContain('aliceFile');
      // But not the thread of a private ticket.
      expect(open.messages).not.toContain('carolPrivateMessage');
    });

    it('hides the whole thread when its ticket is hidden, and shows it again after', async () => {
      await seedTicket('thread', A, { contactId: A.bob });
      await seedMessage('threadMessage', A, 'thread', 'public');
      await seedAttachment('threadFile', A, 'thread', 'threadMessage');
      const bob = asBob(A, 'own');
      const set = (values: Partial<typeof tickets.$inferInsert>) =>
        withSystem(db, brandA, (tx) =>
          tx
            .update(tickets)
            .set(values)
            .where(eq(tickets.id, t.thread ?? '')),
        );

      expect((await rowsOf(bob)).messages).toContain('threadMessage');
      await set({ deletedAt: new Date() });
      const hidden = await rowsOf(bob);
      expect(hidden.messages).not.toContain('threadMessage');
      expect(hidden.files).not.toContain('threadFile');
      await set({ deletedAt: null });
      expect((await rowsOf(bob)).files).toContain('threadFile');
    });

    it('takes a message’s kind from the thread when it changes', async () => {
      await seedMessage('flip', A, 'bobTicket', 'public');
      await seedAttachment('flipFile', A, 'bobTicket', 'flip');
      const bob = asBob(A, 'own');
      const kind = (value: 'public' | 'note') =>
        withSystem(db, brandA, (tx) =>
          tx
            .update(ticketMessages)
            .set({ kind: value })
            .where(eq(ticketMessages.id, t.flip ?? '')),
        );

      expect((await rowsOf(bob)).files).toContain('flipFile');
      await kind('note');
      const noted = await rowsOf(bob);
      expect(noted.messages).not.toContain('flip');
      expect(noted.files).not.toContain('flipFile');
      await kind('public');
      expect((await rowsOf(bob)).files).toContain('flipFile');
    });

    it('shows a file once it is linked to a public message', async () => {
      await seedAttachment('late', A, 'bobTicket', null);
      const bob = asBob(A, 'own');
      expect((await rowsOf(bob)).files).not.toContain('late');

      await withSystem(db, brandA, (tx) =>
        tx
          .update(attachments)
          .set({ messageId: t.bobPublic ?? null })
          .where(eq(attachments.id, t.late ?? '')),
      );
      expect((await rowsOf(bob)).files).toContain('late');
    });

    it('cannot be told a different ticket by the writer: the trigger overwrites the portal columns', async () => {
      const id = uuidv7();
      await withSystem(db, brandA, (tx) =>
        tx.insert(ticketMessages).values({
          id,
          brandId: brandA,
          ticketId: t.erinTicket ?? '',
          departmentId: A.support,
          seq: nextNumber(),
          kind: 'public',
          authorType: 'contact',
          bodyHtml: '<p>x</p>',
          bodyText: 'x',
          channel: 'email',
          // A caller reaching for somebody else's audience.
          portalContactIds: [A.bob],
          portalAccountId: A.acme,
        }),
      );

      expect((await rowsOf(asBob(A, 'account'))).messages.includes(id)).toBe(false);
    });
  });

  describe('brand isolation', () => {
    it('shows brand A’s customer nothing of brand B', async () => {
      const facts = customer(A, A.bob, 'account', A.acme, 'all');

      const [tickets_, messages_, sessions_] = await withCustomer(db, facts, async (tx) => [
        (await tx.execute(sql`SELECT id FROM tickets WHERE brand_id = ${brandB}::uuid`)).length,
        (await tx.execute(sql`SELECT id FROM ticket_messages WHERE brand_id = ${brandB}::uuid`))
          .length,
        (await tx.execute(sql`SELECT id FROM customer_sessions WHERE brand_id = ${brandB}::uuid`))
          .length,
      ]);

      expect([tickets_, messages_, sessions_]).toEqual([0, 0, 0]);
    });

    it('shows brand B’s customer brand B’s rows and not brand A’s, though the names match', async () => {
      const facts = customer(B, B.bob, 'own', B.acme);

      expect(names(await ticketIdsFor(facts))).toEqual(['bobTicketB']);
    });

    it('does not let a contact of brand A be used to read brand B', async () => {
      // Brand A's contact id inside brand B's context: the brand policy is the
      // one that refuses, so nothing is returned whoever the contact is.
      const facts = { ...customer(B, A.bob, 'own', B.acme), contactId: A.bob };

      expect(await ticketIdsFor(facts)).toEqual([]);
    });
  });

  describe('what a customer cannot do', () => {
    it('cannot create, change or delete a ticket or a message', async () => {
      const bob = asBob(A, 'account');
      const attempts = await withCustomer(db, bob, async (tx) => {
        const refusal = (run: (inner: DbTransaction) => PromiseLike<unknown>) =>
          tx
            .transaction(async (inner) => {
              await run(inner);
            })
            .then(
              () => 'accepted',
              (error: { cause?: { message?: string } }) => error.cause?.message ?? 'error',
            );

        return {
          insertTicket: await refusal((inner) =>
            inner.insert(tickets).values({
              brandId: brandA,
              departmentId: A.support,
              number: nextNumber(),
              prefix: 'T',
              subject: 'forged',
              statusId: A.open,
              channel: 'email',
              contactId: A.bob,
            }),
          ),
          insertMessage: await refusal((inner) =>
            inner.insert(ticketMessages).values({
              brandId: brandA,
              ticketId: t.bobTicket ?? '',
              departmentId: A.support,
              seq: nextNumber(),
              kind: 'public',
              authorType: 'contact',
              bodyHtml: '<p>forged</p>',
              bodyText: 'forged',
              channel: 'email',
            }),
          ),
          updateTicket: (
            await tx.execute(sql`UPDATE tickets SET subject = 'x' WHERE id = ${t.bobTicket}::uuid`)
          ).count,
          deleteTicket: (await tx.execute(sql`DELETE FROM tickets WHERE id = ${t.bobTicket}::uuid`))
            .count,
          updateMessage: (
            await tx.execute(
              sql`UPDATE ticket_messages SET body_text = 'x' WHERE id = ${t.bobPublic}::uuid`,
            )
          ).count,
          deleteMessage: (
            await tx.execute(sql`DELETE FROM ticket_messages WHERE id = ${t.bobPublic}::uuid`)
          ).count,
          deleteFile: (await tx.execute(sql`DELETE FROM attachments WHERE id = ${t.bobFile}::uuid`))
            .count,
        };
      });

      expect(attempts.insertTicket).toMatch(/row-level security/i);
      expect(attempts.insertMessage).toMatch(/row-level security/i);
      expect([
        attempts.updateTicket,
        attempts.deleteTicket,
        attempts.updateMessage,
        attempts.deleteMessage,
        attempts.deleteFile,
      ]).toEqual([0, 0, 0, 0, 0]);

      const [ticket] = await withSystem(db, brandA, (tx) =>
        tx
          .select({ subject: tickets.subject })
          .from(tickets)
          .where(eq(tickets.id, t.bobTicket ?? '')),
      );
      expect(ticket?.subject).toBe('bobTicket');
    });

    it('cannot turn a private ticket public, or move a ticket to its own account', async () => {
      const carol = customer(A, A.carol, 'account', A.acme);
      const updated = await withCustomer(
        db,
        carol,
        async (tx) =>
          (
            await tx.execute(
              sql`UPDATE tickets SET portal_private = false, account_id = ${A.acme}::uuid
                WHERE id = ${t.carolPrivate}::uuid`,
            )
          ).count,
      );

      expect(updated).toBe(0);
    });

    it('cannot read the staff-only tables of its own brand, whatever they hold', async () => {
      // The per-table sweep is in `rls.integration.test.ts`; these are the
      // tables a portal page is most tempted to join: notes, activity, tags.
      const bob = asBob(A, 'account');
      const counts = await withCustomer(db, bob, async (tx) => {
        const count = async (table: string): Promise<number> =>
          (await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)}`)).length;

        return {
          participants: await count('ticket_participants'),
          activity: await count('ticket_activity'),
          contacts: await count('contacts'),
          identities: await count('contact_identities'),
          accounts: await count('accounts'),
          notes: await count('contact_notes'),
          audit: await count('audit_log'),
          ai: await count('ai_calls'),
          sla: await count('ticket_sla_clocks'),
          time: await count('ticket_time_entries'),
          tags: await count('ticket_tags'),
          statuses: await count('ticket_statuses'),
          departments: await count('departments'),
          tokens: await count('customer_sign_in_tokens'),
        };
      });

      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    });
  });

  describe('sessions and sign-in links', () => {
    const sessionId = uuidv7();
    const otherSessionId = uuidv7();
    let identityOf: Record<string, string>;

    const sessionRows = (tx: DbTransaction) =>
      tx.select({ id: customerSessions.id }).from(customerSessions);

    beforeAll(async () => {
      const rows = await withSystem(db, brandA, (tx) =>
        tx
          .select({ id: contactIdentities.id, contactId: contactIdentities.contactId })
          .from(contactIdentities),
      );
      identityOf = Object.fromEntries(rows.map((row) => [row.contactId, row.id]));

      await withSystem(db, brandA, (tx) =>
        tx.insert(customerSessions).values([
          {
            id: sessionId,
            brandId: brandA,
            contactId: A.bob,
            contactIdentityId: identityOf[A.bob] ?? '',
            tokenHash: 'bob-session',
            expiresAt: new Date(Date.now() + 86_400_000),
            host: 'help.acme.example',
          },
          {
            id: otherSessionId,
            brandId: brandA,
            contactId: A.alice,
            contactIdentityId: identityOf[A.alice] ?? '',
            tokenHash: 'alice-session',
            expiresAt: new Date(Date.now() + 86_400_000),
            host: 'help.acme.example',
          },
        ]),
      );
      await withSystem(db, brandA, (tx) =>
        tx.insert(customerSignInTokens).values({
          brandId: brandA,
          email: 'bob@example.com',
          contactId: A.bob,
          tokenHash: 'bob-link',
          expiresAt: new Date(Date.now() + 900_000),
        }),
      );
    });

    const as = (principalType: 'staff' | 'visitor' | 'apikey' | 'system') => ({
      brandIds: [brandA],
      departmentIds: 'all' as const,
      principalType,
      principalId: principalType === 'system' ? 'job:test' : uuidv7(),
    });

    it('shows a customer their own sessions and no coworker’s', async () => {
      const rows = await withCustomer(db, asBob(A, 'account'), sessionRows);

      expect(rows.map((row) => row.id)).toEqual([sessionId]);
    });

    it('shows the system path and staff every session of the brand, and nobody else', async () => {
      for (const principalType of ['system', 'staff'] as const) {
        const rows = await withTenant(db, as(principalType), sessionRows);
        expect(rows.map((row) => row.id).sort()).toEqual([sessionId, otherSessionId].sort());
      }
      for (const principalType of ['visitor', 'apikey'] as const) {
        expect(await withTenant(db, as(principalType), sessionRows)).toEqual([]);
      }
    });

    it('lets only the system path write a session', async () => {
      const insert = (principalType: 'staff' | 'visitor' | 'apikey') =>
        withTenant(db, as(principalType), (tx) =>
          tx.insert(customerSessions).values({
            brandId: brandA,
            contactId: A.bob,
            contactIdentityId: identityOf[A.bob] ?? '',
            tokenHash: `forged-${principalType}`,
            expiresAt: new Date(Date.now() + 1000),
            host: 'help.acme.example',
          }),
        ).then(
          () => 'accepted',
          (error: { cause?: { message?: string } }) => error.cause?.message ?? 'error',
        );

      for (const principalType of ['staff', 'visitor', 'apikey'] as const) {
        expect(await insert(principalType)).toMatch(/row-level security/i);
      }
      const asCustomer = await withCustomer(db, asBob(A, 'own'), (tx) =>
        tx.transaction((inner) =>
          inner.insert(customerSessions).values({
            brandId: brandA,
            contactId: A.bob,
            contactIdentityId: identityOf[A.bob] ?? '',
            tokenHash: 'forged-customer',
            expiresAt: new Date(Date.now() + 1000),
            host: 'help.acme.example',
          }),
        ),
      ).then(
        () => 'accepted',
        (error: { cause?: { message?: string } }) => error.cause?.message ?? 'error',
      );
      expect(asCustomer).toMatch(/row-level security/i);
    });

    it('lets neither staff nor the customer change or end a session', async () => {
      const staffCounts = await withTenant(db, as('staff'), async (tx) => [
        (await tx.execute(sql`UPDATE customer_sessions SET host = 'x'`)).count,
        (await tx.execute(sql`DELETE FROM customer_sessions`)).count,
      ]);
      const customerCounts = await withCustomer(db, asBob(A, 'own'), async (tx) => [
        (await tx.execute(sql`UPDATE customer_sessions SET expires_at = now() + interval '1 year'`))
          .count,
        (await tx.execute(sql`DELETE FROM customer_sessions`)).count,
      ]);

      expect(staffCounts).toEqual([0, 0]);
      expect(customerCounts).toEqual([0, 0]);
    });

    it('keeps the sign-in links to the system path, for reading as well', async () => {
      const readable = async (
        context: ReturnType<typeof as> | { principal: 'customer' },
      ): Promise<number> => {
        const run = (tx: DbTransaction) =>
          tx.select({ id: customerSignInTokens.id }).from(customerSignInTokens);
        const rows =
          'principal' in context
            ? await withCustomer(db, asBob(A, 'own'), run)
            : await withTenant(db, context, run);
        return rows.length;
      };

      expect(await readable(as('system'))).toBe(1);
      expect(await readable(as('staff'))).toBe(0);
      expect(await readable(as('visitor'))).toBe(0);
      expect(await readable(as('apikey'))).toBe(0);
      expect(await readable({ principal: 'customer' })).toBe(0);
    });

    it('ends a customer’s sessions with the contact', async () => {
      const leaver = uuidv7();
      await withSystem(db, brandA, async (tx) => {
        await tx.insert(contacts).values({ id: leaver, brandId: brandA, name: 'Leo' });
        const [identity] = await tx
          .insert(contactIdentities)
          .values({
            brandId: brandA,
            contactId: leaver,
            kind: 'email',
            value: 'leo@example.com',
            verified: true,
            source: 'test',
          })
          .returning({ id: contactIdentities.id });
        await tx.insert(customerSessions).values({
          brandId: brandA,
          contactId: leaver,
          contactIdentityId: identity?.id ?? '',
          tokenHash: 'leo-session',
          expiresAt: new Date(Date.now() + 1000),
          host: 'help.acme.example',
        });
        await tx.delete(contactIdentities).where(eq(contactIdentities.contactId, leaver));
      });

      const rows = await withSystem(db, brandA, (tx) =>
        tx
          .select({ id: customerSessions.id })
          .from(customerSessions)
          .where(eq(customerSessions.tokenHash, 'leo-session')),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('every other principal is unchanged', () => {
    const as = (principalType: 'staff' | 'visitor' | 'apikey' | 'system') => ({
      brandIds: [brandA],
      departmentIds: 'all' as const,
      principalType,
      principalId: principalType === 'system' ? 'job:test' : uuidv7(),
    });

    it.each(['staff', 'visitor', 'apikey', 'system'] as const)(
      'still reads every ticket, note and file of the brand as %s',
      async (principalType) => {
        const rows = await withTenant(db, as(principalType), async (tx) => ({
          tickets: (await tx.select({ id: tickets.id }).from(tickets)).length,
          notes: (
            await tx
              .select({ id: ticketMessages.id })
              .from(ticketMessages)
              .where(eq(ticketMessages.kind, 'note'))
          ).length,
          files: (await tx.select({ id: attachments.id }).from(attachments)).length,
        }));

        expect(rows.tickets).toBeGreaterThan(10);
        expect(rows.notes).toBeGreaterThan(0);
        expect(rows.files).toBeGreaterThan(3);
      },
    );

    it('still lets staff write a ticket, a message and a participant', async () => {
      await seedTicket('staffMade', A, { contactId: A.bob });
      await seedMessage('staffMessage', A, 'staffMade', 'note');

      const [row] = await withTenant(db, as('staff'), (tx) =>
        tx
          .update(tickets)
          .set({ subject: 'edited' })
          .where(eq(tickets.id, t.staffMade ?? ''))
          .returning({ subject: tickets.subject }),
      );

      expect(row?.subject).toBe('edited');
    });
  });

  describe('where a CC came from (DOMAIN-RULES §2.5)', () => {
    const sourceCases = [
      // A staff action: an agent adding a CC, or a staff-initiated ticket merge.
      ['agent', true],
      ['merge', true],
      // Mail of any kind (authentication cannot be proved from the headers, a
      // relay writes its own), an import: a forged Cc line must not hand a
      // ticket to whoever owns the address.
      ['email', false],
      ['import', false],
    ] as const;

    it.each(sourceCases)('a verified CC added as %s sees the ticket: %s', async (source, sees) => {
      const key = `cc-${source}`;
      await seedTicket(key, A, { contactId: A.dave });
      await withSystem(db, brandA, (tx) =>
        tx.insert(ticketParticipants).values({
          brandId: brandA,
          ticketId: t[key] ?? '',
          departmentId: A.support,
          contactId: A.carol,
          address: 'carol@example.com',
          source,
        }),
      );

      const visible = names(await ticketIdsFor(customer(A, A.carol, 'own', A.acme)));

      expect(visible.includes(key)).toBe(sees);
    });

    it('trusts the CC the moment its source is corrected, and not before', async () => {
      await seedTicket('cc-late', A, { contactId: A.dave });
      const [row] = await withSystem(db, brandA, (tx) =>
        tx
          .insert(ticketParticipants)
          .values({
            brandId: brandA,
            ticketId: t['cc-late'] ?? '',
            departmentId: A.support,
            contactId: A.carol,
            address: 'carol@example.com',
            source: 'email',
          })
          .returning({ id: ticketParticipants.id }),
      );
      const carol = customer(A, A.carol, 'own', A.acme);
      expect(names(await ticketIdsFor(carol))).not.toContain('cc-late');

      await withSystem(db, brandA, (tx) =>
        tx
          .update(ticketParticipants)
          .set({ source: 'agent' })
          .where(eq(ticketParticipants.id, row?.id ?? '')),
      );
      expect(names(await ticketIdsFor(carol))).toContain('cc-late');
    });
  });

  describe('a caller cannot choose the audience (S2)', () => {
    const limited = {
      brandIds: [brandA],
      departmentIds: [A.support],
      principalType: 'staff' as const,
      principalId: uuidv7(),
    };

    it('recomputes every portal column of a ticket a department-limited agent updates', async () => {
      const before = async (id: string) =>
        withSystem(db, brandA, async (tx) => {
          const [row] = await tx
            .select({
              accountId: tickets.accountId,
              eligible: tickets.portalEligible,
              ids: tickets.portalContactIds,
            })
            .from(tickets)
            .where(eq(tickets.id, id));
          return row;
        });
      const bobTicketBefore = await before(t.bobTicket ?? '');
      const spamBefore = await before(t.bobSpam ?? '');

      await withTenant(db, limited, async (tx) => {
        await tx
          .update(tickets)
          .set({ portalContactIds: [A.erin], accountId: A.other, portalEligible: false })
          .where(eq(tickets.id, t.bobTicket ?? ''));
        await tx
          .update(tickets)
          .set({ portalContactIds: [A.erin], portalEligible: true })
          .where(eq(tickets.id, t.bobSpam ?? ''));
      });

      expect(await before(t.bobTicket ?? '')).toEqual(bobTicketBefore);
      expect(await before(t.bobSpam ?? '')).toEqual(spamBefore);
      expect(spamBefore?.eligible).toBe(false);
    });

    it('recomputes the portal columns of a message, a note included, and of a file', async () => {
      const readMessage = (id: string) =>
        withSystem(db, brandA, async (tx) => {
          const [row] = await tx
            .select({
              ids: ticketMessages.portalContactIds,
              account: ticketMessages.portalAccountId,
            })
            .from(ticketMessages)
            .where(eq(ticketMessages.id, id));
          return row;
        });
      const readFile = (id: string) =>
        withSystem(db, brandA, async (tx) => {
          const [row] = await tx
            .select({ ids: attachments.portalContactIds, account: attachments.portalAccountId })
            .from(attachments)
            .where(eq(attachments.id, id));
          return row;
        });
      const keys = ['bobPublic', 'bobNote'] as const;
      const fileKeys = ['bobFile', 'bobNoteFile'] as const;
      const messagesBefore = await Promise.all(keys.map((key) => readMessage(t[key] ?? '')));
      const filesBefore = await Promise.all(fileKeys.map((key) => readFile(t[key] ?? '')));

      await withTenant(db, limited, async (tx) => {
        for (const key of keys) {
          await tx
            .update(ticketMessages)
            .set({ portalContactIds: [A.erin], portalAccountId: A.other })
            .where(eq(ticketMessages.id, t[key] ?? ''));
        }
        for (const key of fileKeys) {
          await tx
            .update(attachments)
            .set({ portalContactIds: [A.erin], portalAccountId: A.other })
            .where(eq(attachments.id, t[key] ?? ''));
        }
      });

      expect(await Promise.all(keys.map((key) => readMessage(t[key] ?? '')))).toEqual(
        messagesBefore,
      );
      expect(await Promise.all(fileKeys.map((key) => readFile(t[key] ?? '')))).toEqual(filesBefore);
      expect(messagesBefore[1]).toEqual({ ids: [], account: null });
      expect(filesBefore[1]).toEqual({ ids: [], account: null });
      expect(messagesBefore[0]?.ids).toContain(A.bob);
    });
  });

  describe('the triggers reach what a department-limited agent cannot read (S5)', () => {
    // An agent of HR only: the support tickets below are outside their scope.
    const hrAgent = {
      brandIds: [brandA],
      departmentIds: [A.hr],
      principalType: 'staff' as const,
      principalId: uuidv7(),
    };
    const idsOf = (ticketKey: string) =>
      withSystem(db, brandA, async (tx) => {
        const [row] = await tx
          .select({ ids: tickets.portalContactIds, account: tickets.accountId })
          .from(tickets)
          .where(eq(tickets.id, t[ticketKey] ?? ''));
        return row;
      });

    it('moves a contact’s support tickets to the new account', async () => {
      await seedTicket('hr-move', A, { contactId: A.dave });
      expect((await idsOf('hr-move'))?.account).toBeNull();

      await withTenant(db, hrAgent, (tx) =>
        tx.update(contacts).set({ accountId: A.acme }).where(eq(contacts.id, A.dave)),
      );
      expect((await idsOf('hr-move'))?.account).toBe(A.acme);

      await withTenant(db, hrAgent, (tx) =>
        tx.update(contacts).set({ accountId: null }).where(eq(contacts.id, A.dave)),
      );
      expect((await idsOf('hr-move'))?.account).toBeNull();
    });

    it('takes a CC off a support ticket when its identity is unverified', async () => {
      await seedTicket('hr-cc', A, { contactId: A.dave });
      await withSystem(db, brandA, (tx) =>
        tx.insert(ticketParticipants).values({
          brandId: brandA,
          ticketId: t['hr-cc'] ?? '',
          departmentId: A.support,
          contactId: A.erin,
          address: 'erin@example.com',
          source: 'agent',
        }),
      );
      expect((await idsOf('hr-cc'))?.ids).toContain(A.erin);

      await withTenant(db, hrAgent, (tx) =>
        tx
          .update(contactIdentities)
          .set({ verified: false })
          .where(eq(contactIdentities.contactId, A.erin)),
      );
      expect((await idsOf('hr-cc'))?.ids).not.toContain(A.erin);

      await withTenant(db, hrAgent, (tx) =>
        tx
          .update(contactIdentities)
          .set({ verified: true })
          .where(eq(contactIdentities.contactId, A.erin)),
      );
      expect((await idsOf('hr-cc'))?.ids).toContain(A.erin);
    });

    it('takes a CC off a support ticket when its contact is deleted', async () => {
      const leaving = uuidv7();
      await withSystem(db, brandA, async (tx) => {
        await tx.insert(contacts).values({ id: leaving, brandId: brandA, name: 'Lee' });
        await tx.insert(contactIdentities).values({
          brandId: brandA,
          contactId: leaving,
          kind: 'email',
          value: 'lee@example.com',
          verified: true,
          source: 'test',
        });
      });
      await seedTicket('hr-gone', A, { contactId: A.dave });
      await withSystem(db, brandA, (tx) =>
        tx.insert(ticketParticipants).values({
          brandId: brandA,
          ticketId: t['hr-gone'] ?? '',
          departmentId: A.support,
          contactId: leaving,
          address: 'lee@example.com',
          source: 'agent',
        }),
      );
      expect((await idsOf('hr-gone'))?.ids).toContain(leaving);

      await withTenant(db, hrAgent, (tx) => tx.delete(contacts).where(eq(contacts.id, leaving)));
      expect((await idsOf('hr-gone'))?.ids).toEqual([A.dave]);
    });
  });

  describe('an unknown or half-set principal reads nothing (S3)', () => {
    const tables = [
      'tickets',
      'ticket_messages',
      'attachments',
      'contacts',
      'customer_sessions',
    ] as const;
    const raw = (settings: Record<string, string>) =>
      db.transaction(async (tx) => {
        const base: Record<string, string> = {
          'app.brand_ids': `{${brandA}}`,
          'app.department_ids': '{}',
          'app.all_departments': 'true',
          ...settings,
        };
        for (const [name, value] of Object.entries(base)) {
          await tx.execute(sql`SELECT set_config(${name}, ${value}, true)`);
        }
        const counts: Record<string, number> = {};
        for (const table of tables) {
          counts[table] = (await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)}`)).length;
        }
        return counts;
      });
    const complete = {
      'app.customer_contact_id': A.bob,
      'app.customer_account_id': A.acme,
      'app.customer_sees': 'account',
    };
    const zero = {
      tickets: 0,
      ticket_messages: 0,
      attachments: 0,
      contacts: 0,
      customer_sessions: 0,
    };

    it('has something to hide: a system principal reads all five', async () => {
      const counts = await raw({ 'app.principal_type': 'system', 'app.principal_id': 'job:x' });

      expect(Object.values(counts).every((n) => n > 0)).toBe(true);
    });

    it.each([
      ['a customer type with no facts', { 'app.principal_type': 'customer' }],
      [
        'a customer who sees the account with an empty account id',
        {
          'app.principal_type': 'customer',
          'app.customer_contact_id': '',
          'app.customer_account_id': '',
          'app.customer_sees': 'account',
        },
      ],
      [
        'a customer with an empty contact id',
        { ...complete, 'app.principal_type': 'customer', 'app.customer_contact_id': '' },
      ],
      [
        'an unknown type with the facts of a customer',
        { ...complete, 'app.principal_type': 'portal' },
      ],
      ['a type in the wrong case', { ...complete, 'app.principal_type': 'Customer' }],
      ['a type with a trailing space', { ...complete, 'app.principal_type': 'customer ' }],
      ['an empty type', { ...complete, 'app.principal_type': '' }],
      ['no type at all', { ...complete }],
    ])('returns zero rows to %s', async (_name, settings) => {
      expect(await raw(settings)).toEqual(
        // A customer with no facts still reads nothing; only a customer who is
        // on a ticket reads one, and `complete` names Bob with no type above.
        zero,
      );
    });
  });

  describe('the audience is race-safe (S1)', () => {
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const messageValues = (ticketKey: string, id: string) => ({
      id,
      brandId: brandA,
      ticketId: t[ticketKey] ?? '',
      departmentId: A.support,
      seq: nextNumber(),
      kind: 'public' as const,
      authorType: 'contact' as const,
      bodyHtml: '<p>r</p>',
      bodyText: 'r',
      channel: 'email' as const,
    });
    const audience = (id: string) =>
      withSystem(db, brandA, async (tx) => {
        const [row] = await tx
          .select({ ids: ticketMessages.portalContactIds, account: ticketMessages.portalAccountId })
          .from(ticketMessages)
          .where(eq(ticketMessages.id, id));
        return row;
      });
    const hide = {
      private: { portalPrivate: true },
      spam: { statusId: A.spam },
    } as const;

    it.each(['private', 'spam'] as const)(
      'a message inserted while the ticket becomes %s ends with no audience, insert first',
      async (reason) => {
        const key = `race-in-${reason}`;
        await seedTicket(key, A, { contactId: A.bob });
        const id = uuidv7();
        const inserted = gate();
        const release = gate();
        const writer = withSystem(db, brandA, async (tx) => {
          await tx.insert(ticketMessages).values(messageValues(key, id));
          inserted.open();
          await release.opened;
        });
        await inserted.opened;
        const updater = withSystem(db, brandA, (tx) =>
          tx
            .update(tickets)
            .set(hide[reason])
            .where(eq(tickets.id, t[key] ?? '')),
        );
        await pause(300);
        release.open();
        await Promise.all([writer, updater]);

        const row = await audience(id);
        expect(row?.account).toBeNull();
        if (reason === 'spam') {
          expect(row?.ids).toEqual([]);
        }
      },
    );

    it.each(['private', 'spam'] as const)(
      'a message inserted while the ticket becomes %s ends with no audience, update first',
      async (reason) => {
        const key = `race-up-${reason}`;
        await seedTicket(key, A, { contactId: A.bob });
        const id = uuidv7();
        const updated = gate();
        const release = gate();
        let writerDone = false;
        const updater = withSystem(db, brandA, async (tx) => {
          await tx
            .update(tickets)
            .set(hide[reason])
            .where(eq(tickets.id, t[key] ?? ''));
          updated.open();
          await release.opened;
        });
        await updated.opened;
        const writer = withSystem(db, brandA, (tx) =>
          tx.insert(ticketMessages).values(messageValues(key, id)),
        ).then(() => {
          writerDone = true;
        });
        await pause(300);
        expect(writerDone).toBe(false);
        release.open();
        await Promise.all([updater, writer]);

        const row = await audience(id);
        expect(row?.account).toBeNull();
        if (reason === 'spam') {
          expect(row?.ids).toEqual([]);
        }
      },
    );

    it('a file attached while its ticket becomes private ends with no audience, in either order', async () => {
      for (const order of ['file-first', 'update-first'] as const) {
        const key = `race-file-${order}`;
        await seedTicket(key, A, { contactId: A.bob });
        const messageKey = `${key}-message`;
        await seedMessage(messageKey, A, key, 'public');
        const fileId = uuidv7();
        const attach = (tx: DbTransaction) =>
          tx.insert(attachments).values({
            id: fileId,
            brandId: brandA,
            ticketId: t[key] ?? '',
            departmentId: A.support,
            messageId: t[messageKey] ?? null,
            uploaderType: 'staff',
            uploaderId: 'test',
            s3Key: `brands/${brandA}/${key}`,
            originalName: 'r.png',
            mime: 'image/png',
            size: 1,
            kind: 'image',
            status: 'ready',
          });
        const makePrivate = (tx: DbTransaction) =>
          tx
            .update(tickets)
            .set({ portalPrivate: true })
            .where(eq(tickets.id, t[key] ?? ''));
        const first = gate();
        const release = gate();
        const holder = withSystem(db, brandA, async (tx) => {
          await (order === 'file-first' ? attach(tx) : makePrivate(tx));
          first.open();
          await release.opened;
        });
        await first.opened;
        const second = withSystem(db, brandA, (tx) =>
          order === 'file-first' ? makePrivate(tx) : attach(tx),
        );
        await pause(300);
        release.open();
        await Promise.all([holder, second]);

        const [file] = await withSystem(db, brandA, (tx) =>
          tx
            .select({ account: attachments.portalAccountId, ids: attachments.portalContactIds })
            .from(attachments)
            .where(eq(attachments.id, fileId)),
        );
        expect(file?.account, order).toBeNull();
        expect(file?.ids, order).toEqual([A.bob]);
      }
    }, 60_000);
  });

  describe('the policies', () => {
    it('are restrictive, so a mistake in them can only hide rows', async () => {
      const rows = await owner.db.execute<{ tablename: string; permissive: string }>(
        sql`SELECT tablename, permissive FROM pg_policies
            WHERE policyname ~ '(_customer_|_no_customer$|_system_only$)'`,
      );

      expect(rows.length).toBeGreaterThan(100);
      expect([...rows].every((row) => row.permissive === 'RESTRICTIVE')).toBe(true);
    });

    it('leave every tenant table with row security forced', async () => {
      const unforced = await owner.db.execute<{ relname: string }>(
        sql`SELECT c.relname FROM pg_class c
            JOIN pg_policy p ON p.polrelid = c.oid
            WHERE NOT c.relforcerowsecurity GROUP BY c.relname`,
      );

      expect([...unforced]).toEqual([]);
    });
  });

  describe('the trigger on a contact’s move (50,000 tickets)', () => {
    // The point is that a move is three set-based statements and not a
    // per-ticket cascade (ADR 0060, M21 risks). Measured at about 30 s on a
    // laptop for 50,000 tickets, 50,000 messages and 50,000 files; the bound is
    // generous for a CI runner and tight enough to catch a per-row regression
    // (the per-ticket cascade this replaced took 74 s).
    const SLOW_MOVE_BOUND_MS = 120_000;

    it('moves a contact with 50,000 tickets, their messages and their files, within the bound', async () => {
      const mover = uuidv7();
      await withSystem(db, brandA, async (tx) => {
        await tx.insert(contacts).values({ id: mover, brandId: brandA, name: 'Mover' });
      });

      // 50,000 tickets, each with one public message and one attachment, written
      // as the owner in three set-based statements (the triggers are the unit
      // under test for the move, not for the seeding).
      await owner.db.execute(sql`ALTER TABLE tickets DISABLE TRIGGER USER`);
      await owner.db.execute(sql`ALTER TABLE ticket_messages DISABLE TRIGGER USER`);
      await owner.db.execute(sql`ALTER TABLE attachments DISABLE TRIGGER USER`);
      await owner.db.execute(sql`ALTER TABLE tickets NO FORCE ROW LEVEL SECURITY`);
      await owner.db.execute(sql`ALTER TABLE ticket_messages NO FORCE ROW LEVEL SECURITY`);
      await owner.db.execute(sql`ALTER TABLE attachments NO FORCE ROW LEVEL SECURITY`);
      try {
        await owner.db.execute(sql`
          INSERT INTO tickets (id, brand_id, department_id, number, prefix, subject, status_id,
                               channel, contact_id, portal_eligible, portal_contact_ids)
          SELECT gen_random_uuid(), ${brandA}::uuid, ${A.support}::uuid, 1000000 + g, 'M',
                 'bulk ' || g, ${A.open}::uuid, 'email', ${mover}::uuid, true, ARRAY[${mover}::uuid]
          FROM generate_series(1, 50000) AS g`);
        await owner.db.execute(sql`
          INSERT INTO ticket_messages (id, brand_id, ticket_id, department_id, seq, kind, author_type,
                                       body_html, body_text, channel, portal_contact_ids)
          SELECT gen_random_uuid(), brand_id, id, department_id, 1, 'public', 'contact', '<p>x</p>', 'x',
                 'email', ARRAY[${mover}::uuid]
          FROM tickets WHERE contact_id = ${mover}::uuid`);
        await owner.db.execute(sql`
          INSERT INTO attachments (id, brand_id, ticket_id, department_id, message_id, uploader_type,
                                   uploader_id, s3_key, original_name, mime, size, kind, status,
                                   portal_contact_ids)
          SELECT gen_random_uuid(), m.brand_id, m.ticket_id, m.department_id, m.id, 'staff', 'test',
                 'bulk/' || m.id, 'x.png', 'image/png', 1, 'image', 'ready', ARRAY[${mover}::uuid]
          FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id
          WHERE t.contact_id = ${mover}::uuid`);
      } finally {
        await owner.db.execute(sql`ALTER TABLE attachments ENABLE TRIGGER USER`);
        await owner.db.execute(sql`ALTER TABLE ticket_messages ENABLE TRIGGER USER`);
        await owner.db.execute(sql`ALTER TABLE tickets ENABLE TRIGGER USER`);
        await owner.db.execute(sql`ALTER TABLE attachments FORCE ROW LEVEL SECURITY`);
        await owner.db.execute(sql`ALTER TABLE ticket_messages FORCE ROW LEVEL SECURITY`);
        await owner.db.execute(sql`ALTER TABLE tickets FORCE ROW LEVEL SECURITY`);
      }

      const started = performance.now();
      await withSystem(db, brandA, (tx) =>
        tx.update(contacts).set({ accountId: A.acme }).where(eq(contacts.id, mover)),
      );
      const elapsed = performance.now() - started;

      const [moved] = await withSystem(db, brandA, (tx) =>
        tx.execute<{ tickets: number; messages: number; files: number }>(sql`
          SELECT
            (SELECT count(*) FROM tickets WHERE contact_id = ${mover}::uuid AND account_id = ${A.acme}::uuid)::int AS tickets,
            (SELECT count(*) FROM ticket_messages WHERE portal_account_id = ${A.acme}::uuid
               AND ticket_id IN (SELECT id FROM tickets WHERE contact_id = ${mover}::uuid))::int AS messages,
            (SELECT count(*) FROM attachments WHERE portal_account_id = ${A.acme}::uuid
               AND ticket_id IN (SELECT id FROM tickets WHERE contact_id = ${mover}::uuid))::int AS files`),
      );

      expect(moved).toEqual({ tickets: 50_000, messages: 50_000, files: 50_000 });
      expect(elapsed).toBeLessThan(SLOW_MOVE_BOUND_MS);
    }, 600_000);
  });
});
