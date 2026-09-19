import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  userBrandRoles,
  withSystem,
} from '@helpdock/db';
import type {
  Account,
  AccountDetail,
  AccountList,
  ContactDetail,
  ContactList,
  ContactTimeline,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { findOrCreateContactByIdentity } from './identity.js';

/**
 * M1-04 over HTTP, against a real Postgres and a real Redis.
 *
 * The unit suites prove the normalisers and the views decide correctly. This
 * proves the things that are only true of rows: that an identifier is unique
 * inside a brand and free in the brand next door, that a verified match joins
 * an existing contact while an unverified one starts a new one and leaves a
 * suggestion, that an erasure keeps the row and writes an audit line with no
 * value in it, and that brand A cannot reach brand B's people by any route.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');
const APP_URL = 'https://support.example.com';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the contacts integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('contacts and accounts', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let token: string;
  /** A second brand with the same administrator, for the cross-brand cases. */
  let otherBrandId: string;

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
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

  const base = (brandId = seeded.brandId): string => `/api/brands/${brandId}/contacts`;
  const accountsBase = (brandId = seeded.brandId): string => `/api/brands/${brandId}/accounts`;

  const createContact = async (
    body: Record<string, unknown>,
    brandId = seeded.brandId,
  ): Promise<ContactDetail> => {
    const response = await request('POST', base(brandId), { body, headers: auth() });
    expect(response.statusCode).toBe(201);

    return response.json() as ContactDetail;
  };

  const listContacts = async (query = '', brandId = seeded.brandId): Promise<ContactList> => {
    const response = await request('GET', `${base(brandId)}${query}`, { headers: auth() });
    expect(response.statusCode).toBe(200);

    return response.json() as ContactList;
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    const env = envFor();
    runtime = await createRuntime({
      env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
        destination: { write: () => {} },
      }),
    });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });

    const [other] = await runtime.db
      .insert(brands)
      .values({ name: 'Helpdock Second', prefix: 'HDC' })
      .returning({ id: brands.id });
    otherBrandId = other?.id ?? '';
    await withSystem(runtime.db, otherBrandId, async (tx) => {
      await tx
        .insert(userBrandRoles)
        .values({ userId: seeded.userId, brandId: otherBrandId, role: 'admin' });
    });

    const first = await request('POST', '/api/auth/sign-in', {
      body: { email: seeded.email, password: seeded.password },
    });
    const second = await request('POST', '/api/auth/totp', {
      body: {
        challengeId: (first.json() as { challengeId: string }).challengeId,
        code: await generate({ secret: seeded.totpSecret ?? '', period: 30 }),
        trustDevice: false,
      },
    });
    token = (second.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------------

  describe('creating and reading', () => {
    it('creates a contact with a normalised identifier', async () => {
      const created = await createContact({
        name: 'Mona Khalil',
        identities: [{ kind: 'email', value: '  Mona@Example.COM ' }],
      });

      expect(created.identities).toHaveLength(1);
      expect(created.identities[0]).toMatchObject({
        kind: 'email',
        value: 'mona@example.com',
        // Nothing an agent types is proof (DOMAIN-RULES §4).
        verified: false,
      });
      expect(created.primaryIdentity?.value).toBe('mona@example.com');
    });

    it('refuses an identifier another contact in the brand already holds', async () => {
      await createContact({
        name: 'First',
        identities: [{ kind: 'email', value: 'taken@example.com' }],
      });

      const response = await request('POST', base(), {
        body: {
          name: 'Second',
          identities: [{ kind: 'email', value: 'TAKEN@example.com' }],
        },
        headers: auth(),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { contact: { reason: 'identity-taken' } },
      });
    });

    it('lets the brand next door hold the very same address', async () => {
      const here = await createContact({
        name: 'Same address here',
        identities: [{ kind: 'email', value: 'shared@example.com' }],
      });
      const there = await createContact(
        {
          name: 'Same address there',
          identities: [{ kind: 'email', value: 'shared@example.com' }],
        },
        otherBrandId,
      );

      expect(here.id).not.toBe(there.id);
      expect(there.identities[0]?.value).toBe('shared@example.com');
    });

    it('refuses a value that is not an identifier of that kind, and says how', async () => {
      const response = await request('POST', base(), {
        body: { name: 'Wrong', identities: [{ kind: 'email', value: 'not-an-address' }] },
        headers: auth(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { contact: { reason: 'identity-invalid', problem: 'invalid-email' } },
      });
    });

    it('refuses a national phone number while the brand names no calling code', async () => {
      const response = await request('POST', base(), {
        body: { name: 'Caller', identities: [{ kind: 'phone', value: '030 1234567' }] },
        headers: auth(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { contact: { problem: 'phone-not-international' } },
      });
    });

    it('searches across names and identifiers alike', async () => {
      await createContact({
        name: 'Searchable Person',
        identities: [{ kind: 'email', value: 'findme@example.com' }],
      });

      await expect(listContacts('?search=Searchable')).resolves.toMatchObject({ total: 1 });
      await expect(listContacts('?search=findme@')).resolves.toMatchObject({ total: 1 });
    });

    it('never finds the brand next door, whatever it is asked', async () => {
      await createContact(
        { name: 'Only Over There', identities: [{ kind: 'email', value: 'there@example.com' }] },
        otherBrandId,
      );

      await expect(listContacts('?search=Only Over There')).resolves.toMatchObject({ total: 0 });
      await expect(listContacts('?search=there@example.com')).resolves.toMatchObject({ total: 0 });
    });

    it('reports no tickets and hides none until M1-02 fills the providers', async () => {
      const contact = await createContact({ name: 'No tickets yet' });
      const response = await request('GET', `${base()}/${contact.id}/timeline`, {
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json() as ContactTimeline).toMatchObject({ items: [], hiddenCount: 0 });
      expect(contact.stats).toMatchObject({ openTickets: 0, csat: null });
    });

    it('pages with a cursor rather than an offset', async () => {
      const first = await listContacts('?limit=2');

      expect(first.contacts).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await listContacts(`?limit=2&cursor=${first.nextCursor ?? ''}`);
      const ids = new Set([...first.contacts, ...second.contacts].map((row) => row.id));

      expect(ids.size).toBe(first.contacts.length + second.contacts.length);
    });
  });

  describe('the identity seam', () => {
    it('matches an existing contact on a verified identifier', async () => {
      const existing = await createContact({
        name: 'Verified Match',
        identities: [{ kind: 'email', value: 'verified-match@example.com' }],
      });

      const result = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'Verified-Match@example.com',
          verified: true,
          source: 'email.inbound',
        }),
      );

      expect(result.created).toBe(false);
      expect(result.contact.id).toBe(existing.id);
      // An address that was typed and is now proven is promoted in place.
      expect(result.identity?.verified).toBe(true);
    });

    it('starts a new contact for an unverified identifier somebody else holds', async () => {
      const existing = await createContact({
        name: 'The Original',
        identities: [{ kind: 'email', value: 'contested@example.com' }],
      });

      const result = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'contested@example.com',
          verified: false,
          source: 'widget.form',
          // Typed into a pre-chat form: a hint, not proof (DOMAIN-RULES §4.4).
        }),
      );

      expect(result.created).toBe(true);
      expect(result.contact.id).not.toBe(existing.id);
      expect(result.duplicateOf).toBe(existing.id);
      // The value stays with the contact that already had it.
      expect(result.identity).toBeNull();

      const detail = await request('GET', `${base()}/${result.contact.id}`, { headers: auth() });
      expect((detail.json() as ContactDetail).duplicates).toMatchObject([
        { reason: 'email', other: { id: existing.id } },
      ]);
    });

    it('suggests a pair once, however many times it is seen', async () => {
      const existing = await createContact({
        name: 'Seen Twice',
        identities: [{ kind: 'email', value: 'twice@example.com' }],
      });

      const first = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'twice@example.com',
          verified: false,
          source: 'widget.form',
        }),
      );
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'twice@example.com',
          verified: false,
          source: 'widget.form',
        }),
      );

      const detail = await request('GET', `${base()}/${first.contact.id}`, { headers: auth() });
      expect((detail.json() as ContactDetail).duplicates).toHaveLength(1);
      expect(existing.id).not.toBe(first.contact.id);
    });

    it('dismisses a suggestion, and does not raise it again', async () => {
      await createContact({
        name: 'Dismissible',
        identities: [{ kind: 'email', value: 'dismiss@example.com' }],
      });
      const newcomer = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'dismiss@example.com',
          verified: false,
          source: 'widget.form',
        }),
      );

      const before = await request('GET', `${base()}/${newcomer.contact.id}`, { headers: auth() });
      const suggestionId = (before.json() as ContactDetail).duplicates[0]?.id ?? '';

      const dismissed = await request(
        'POST',
        `${base()}/${newcomer.contact.id}/duplicates/${suggestionId}/dismiss`,
        { headers: auth() },
      );

      expect(dismissed.statusCode).toBe(201);
      expect((dismissed.json() as ContactDetail).duplicates).toEqual([]);

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'dismiss@example.com',
          verified: false,
          source: 'widget.form',
        }),
      );

      const after = await request('GET', `${base()}/${newcomer.contact.id}`, { headers: auth() });
      expect((after.json() as ContactDetail).duplicates).toEqual([]);
    });

    it('creates a contact for an identifier nobody holds', async () => {
      const result = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'telegram',
          value: '884413201',
          verified: true,
          source: 'telegram.bot',
        }),
      );

      expect(result.created).toBe(true);
      expect(result.identity).toMatchObject({ verified: true, kind: 'telegram' });
      // With no name to go on, the identifier is the name.
      expect(result.contact.name).toBe('884413201');
    });
  });

  describe('identifiers on an existing contact', () => {
    it('adds one and refuses to steal it from somebody else', async () => {
      const owner = await createContact({
        name: 'Holder',
        identities: [{ kind: 'email', value: 'holder@example.com' }],
      });
      const other = await createContact({ name: 'Other', identities: [] });

      const added = await request('POST', `${base()}/${other.id}/identities`, {
        body: { kind: 'phone', value: '+49 30 1234 567' },
        headers: auth(),
      });
      expect(added.statusCode).toBe(201);
      expect((added.json() as ContactDetail).identities[0]?.value).toBe('+49301234567');

      const stolen = await request('POST', `${base()}/${other.id}/identities`, {
        body: { kind: 'email', value: 'holder@example.com' },
        headers: auth(),
      });
      expect(stolen.statusCode).toBe(409);
      expect(owner.identities).toHaveLength(1);
    });

    it('keeps a contact from losing its last identifier', async () => {
      const contact = await createContact({
        name: 'One Identifier',
        identities: [{ kind: 'email', value: 'only@example.com' }],
      });
      const identityId = contact.identities[0]?.id ?? '';

      const response = await request('DELETE', `${base()}/${contact.id}/identities/${identityId}`, {
        headers: auth(),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { contact: { reason: 'last-identity' } } });
    });

    it('removes one when another remains', async () => {
      const contact = await createContact({
        name: 'Two Identifiers',
        identities: [
          { kind: 'email', value: 'two-a@example.com' },
          { kind: 'phone', value: '+4930111222333' },
        ],
      });
      const identityId = contact.identities[0]?.id ?? '';

      const response = await request('DELETE', `${base()}/${contact.id}/identities/${identityId}`, {
        headers: auth(),
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as ContactDetail).identities).toHaveLength(1);
    });
  });

  describe('notes and accounts', () => {
    it('adds a note with its author', async () => {
      const contact = await createContact({ name: 'Noted' });
      const response = await request('POST', `${base()}/${contact.id}/notes`, {
        body: { bodyText: 'Prefers Arabic.' },
        headers: auth(),
      });

      expect(response.statusCode).toBe(201);
      expect((response.json() as ContactDetail).notes[0]).toMatchObject({
        bodyText: 'Prefers Arabic.',
        authorId: seeded.userId,
      });
    });

    it('files a contact under an account and refuses a domain twice', async () => {
      const created = await request('POST', accountsBase(), {
        body: { name: 'Acme GmbH', domain: 'Acme.Example' },
        headers: auth(),
      });
      expect(created.statusCode).toBe(201);
      const account = created.json() as Account;
      expect(account.domain).toBe('acme.example');

      const twice = await request('POST', accountsBase(), {
        body: { name: 'Acme two', domain: 'acme.example' },
        headers: auth(),
      });
      expect(twice.statusCode).toBe(409);

      const contact = await createContact({ name: 'Acme person', accountId: account.id });
      expect(contact.account).toMatchObject({ id: account.id, name: 'Acme GmbH' });
    });

    it('lists accounts with how many people each holds, and searches them', async () => {
      const created = await request('POST', accountsBase(), {
        body: { name: 'Nordwind AG', domain: 'nordwind.example' },
        headers: auth(),
      });
      const account = created.json() as Account;
      await createContact({ name: 'Nordwind person', accountId: account.id });

      const listed = await request('GET', `${accountsBase()}?search=Nordwind`, {
        headers: auth(),
      });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as AccountList).accounts).toMatchObject([
        { id: account.id, contactCount: 1 },
      ]);

      const detail = await request('GET', `${accountsBase()}/${account.id}`, { headers: auth() });
      expect(detail.statusCode).toBe(200);
      expect((detail.json() as AccountDetail).contacts).toMatchObject([
        { name: 'Nordwind person' },
      ]);
    });

    it('renames an account and keeps its domain free for itself', async () => {
      const created = await request('POST', accountsBase(), {
        body: { name: 'Renamed Ltd', domain: 'renamed.example' },
        headers: auth(),
      });
      const account = created.json() as Account;

      const updated = await request('PATCH', `${accountsBase()}/${account.id}`, {
        body: { name: 'Renamed GmbH', domain: 'renamed.example' },
        headers: auth(),
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ name: 'Renamed GmbH', domain: 'renamed.example' });
    });

    it('answers 404 for an account of another brand', async () => {
      const created = await request('POST', accountsBase(otherBrandId), {
        body: { name: 'Hidden Ltd' },
        headers: auth(),
      });
      const hidden = created.json() as Account;

      const response = await request('GET', `${accountsBase()}/${hidden.id}`, { headers: auth() });

      expect(response.statusCode).toBe(404);
    });

    it('refuses an account from another brand as if it did not exist', async () => {
      const created = await request('POST', accountsBase(otherBrandId), {
        body: { name: 'Elsewhere Ltd' },
        headers: auth(),
      });
      const elsewhere = created.json() as Account;

      const response = await request('POST', base(), {
        body: { name: 'Confused', accountId: elsewhere.id },
        headers: auth(),
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('erasure (DOMAIN-RULES §11)', () => {
    it('keeps the row, hashes the identifiers, and audits without a value', async () => {
      const contact = await createContact({
        name: 'To Be Erased',
        externalId: 'CUST-777',
        identities: [
          { kind: 'email', value: 'erase-me@example.com' },
          { kind: 'phone', value: '+4930999888777' },
        ],
      });
      await request('POST', `${base()}/${contact.id}/notes`, {
        body: { bodyText: 'Something personal.' },
        headers: auth(),
      });

      const response = await request('POST', `${base()}/${contact.id}/anonymise`, {
        headers: auth(),
      });
      expect(response.statusCode).toBe(201);

      const erased = response.json() as ContactDetail;
      expect(erased.anonymised).toBe(true);
      expect(erased.name).toBe('Erased contact');
      expect(erased.externalId).toBeNull();
      expect(erased.notes).toEqual([]);
      for (const identity of erased.identities) {
        expect(identity.value).toMatch(/^erased:/);
        expect(identity.verified).toBe(false);
      }

      // The row is still there, which is what keeps every ticket pointing at it
      // resolvable.
      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(contacts).where(eq(contacts.id, contact.id)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.anonymisedAt).not.toBeNull();

      const stored = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(contactIdentities).where(eq(contactIdentities.contactId, contact.id)),
      );
      for (const identity of stored) {
        expect(identity.value).not.toContain('@');
        expect(identity.value).not.toContain('4930');
      }

      const [audit] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.targetId, contact.id), eq(auditLog.action, 'contact.anonymised'))),
      );
      expect(audit?.meta).toMatchObject({ identityCount: 2, noteCount: 1 });
      expect(JSON.stringify(audit?.meta)).not.toContain('erase-me@example.com');
      expect(JSON.stringify(audit?.meta)).not.toContain('CUST-777');
    });

    it('closes the duplicate suggestions that pointed at the erased contact', async () => {
      await createContact({
        name: 'Erased with a twin',
        identities: [{ kind: 'email', value: 'twin@example.com' }],
      });
      const newcomer = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value: 'twin@example.com',
          verified: false,
          source: 'widget.form',
        }),
      );

      const before = await request('GET', `${base()}/${newcomer.contact.id}`, { headers: auth() });
      expect((before.json() as ContactDetail).duplicates).toHaveLength(1);

      await request('POST', `${base()}/${newcomer.contact.id}/anonymise`, { headers: auth() });

      // Read from the *other* side: an erased contact must stop being offered
      // as somebody's possible duplicate.
      const other = (before.json() as ContactDetail).duplicates[0]?.other.id ?? '';
      const after = await request('GET', `${base()}/${other}`, { headers: auth() });

      expect((after.json() as ContactDetail).duplicates).toEqual([]);
    });

    it('refuses to change an erased contact afterwards', async () => {
      const contact = await createContact({
        name: 'Erased then edited',
        identities: [{ kind: 'email', value: 'erased-then@example.com' }],
      });
      await request('POST', `${base()}/${contact.id}/anonymise`, { headers: auth() });

      const response = await request('PATCH', `${base()}/${contact.id}`, {
        body: { name: 'Back again' },
        headers: auth(),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { contact: { reason: 'anonymised' } } });
    });

    it('refuses erasure to a role that is not Admin in this brand', async () => {
      const contact = await createContact({ name: 'Agent cannot erase' });

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(userBrandRoles)
          .set({ role: 'agent', departmentIds: [] })
          .where(eq(userBrandRoles.userId, seeded.userId)),
      );

      // The role is read from the access token's claims, so a fresh sign-in is
      // what makes the new role take effect.
      const first = await request('POST', '/api/auth/sign-in', {
        body: { email: seeded.email, password: seeded.password },
      });
      const second = await request('POST', '/api/auth/totp', {
        body: {
          challengeId: (first.json() as { challengeId: string }).challengeId,
          code: await generate({ secret: seeded.totpSecret ?? '', period: 30 }),
          trustDevice: false,
        },
      });
      const agentToken = (second.json() as { accessToken: string }).accessToken;

      const response = await request('POST', `${base()}/${contact.id}/anonymise`, {
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { contact: { reason: 'anonymise-forbidden' } },
      });

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(userBrandRoles)
          .set({ role: 'admin', departmentIds: null })
          .where(eq(userBrandRoles.userId, seeded.userId)),
      );
    });
  });

  describe('tenancy', () => {
    it('answers 404 for a contact of another brand, not 403', async () => {
      const there = await createContact({ name: 'Over there' }, otherBrandId);

      // Asked for under *this* brand: row-level security makes it invisible,
      // so the answer is "no such contact" and nothing leaks that it exists.
      const response = await request('GET', `${base()}/${there.id}`, { headers: auth() });

      expect(response.statusCode).toBe(404);
    });

    it('writes every mutation to the audit log of the brand it happened in', async () => {
      const contact = await createContact({ name: 'Audited' });
      await request('PATCH', `${base()}/${contact.id}`, {
        body: { name: 'Audited twice' },
        headers: auth(),
      });

      const actions = await withSystem(runtime.db, seeded.brandId, async (tx) => {
        const rows = await tx
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetId, contact.id))
          .orderBy(auditLog.createdAt);

        return rows.map((row) => row.action);
      });

      expect(actions).toEqual(['contact.created', 'contact.updated']);
    });
  });
});
