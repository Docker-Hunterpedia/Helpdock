import { createKeyring, decryptSecret } from '@helpdock/config';
import { type Db, type DbTransaction, uuidv7 } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { recordingTx } from '../testing/email-doubles.js';
import { AUTH_EMAIL_EVENT, authEmailEventSchema, OutboxAuthMail } from './auth-email.js';
import type { StaffMembership } from './staff.repository.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') });
const TOKEN = 'the-sign-in-token-itself';
const URL_WITH_TOKEN = `https://support.example.com/api/auth/magic-link/${TOKEN}`;

const membership = (brandId: string): StaffMembership =>
  ({ brandId, userId: uuidv7(), role: 'agent', departmentIds: null }) as StaffMembership;

/** A pool whose one transaction records what was written and the scope it was opened with. */
const recordingDb = () => {
  const outbox: { brandId: string; event: string; payload: Record<string, unknown> }[] = [];
  const scopes: unknown[] = [];
  const tx = {
    execute: (query: unknown) => {
      scopes.push(query);
      return Promise.resolve([]);
    },
    insert: () => ({
      values: (row: (typeof outbox)[number]) => {
        outbox.push(row);
        return { returning: () => Promise.resolve([{ id: uuidv7() }]) };
      },
    }),
  } as unknown as DbTransaction;
  const db = {
    transaction: (fn: (inner: DbTransaction) => Promise<unknown>) => fn(tx),
  } as unknown as Db;

  return { db, outbox, scopes };
};

const mailFor = (memberships: StaffMembership[], db = recordingDb().db) =>
  new OutboxAuthMail({
    db,
    keyring,
    staff: { membershipsOf: () => Promise.resolve(memberships) },
  });

describe('OutboxAuthMail', () => {
  it('writes one outbox row in the caller transaction, with the link sealed', async () => {
    const { tx, outbox } = recordingTx();
    const userId = uuidv7();

    await mailFor([]).queue(tx, uuidv7(), {
      kind: 'invite',
      userId,
      url: URL_WITH_TOKEN,
      expiresIn: 7,
      values: { inviter: 'Lina', brandName: 'Acme', role: 'Agent' },
    });

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event).toBe(AUTH_EMAIL_EVENT);
    const payload = authEmailEventSchema.parse(outbox[0]?.payload);
    expect(payload).toMatchObject({ kind: 'invite', userId, expiresIn: 7 });
    expect(payload.values).toEqual({ inviter: 'Lina', brandName: 'Acme', role: 'Agent' });
    expect(JSON.stringify(outbox[0]?.payload)).not.toContain(TOKEN);
    expect(decryptSecret(payload.urlEncrypted, keyring)).toBe(URL_WITH_TOKEN);
  });

  it('routes an anonymous request through the lowest brand the account works in', async () => {
    const recording = recordingDb();
    const first = '01924f00-0000-7000-8000-000000000001';
    const second = '01924f00-0000-7000-8000-000000000002';

    const queued = await mailFor(
      [membership(second), membership(first)],
      recording.db,
    ).queueForAccount({
      kind: 'passwordReset',
      userId: uuidv7(),
      url: URL_WITH_TOKEN,
      expiresIn: 10,
    });

    expect(queued).toBe(true);
    expect(recording.scopes).toHaveLength(1);
    expect(recording.outbox.map((row) => row.brandId)).toEqual([first]);
    expect(authEmailEventSchema.parse(recording.outbox[0]?.payload).values).toBeUndefined();
    expect(JSON.stringify(recording.outbox)).not.toContain(TOKEN);
  });

  it('queues nothing for an account with no role in an active brand', async () => {
    const recording = recordingDb();

    const queued = await mailFor([], recording.db).queueForAccount({
      kind: 'magicLink',
      userId: uuidv7(),
      url: URL_WITH_TOKEN,
      expiresIn: 10,
    });

    expect(queued).toBe(false);
    expect(recording.scopes).toEqual([]);
    expect(recording.outbox).toEqual([]);
  });
});
