import { GraphApiFailure, type GraphClient } from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import type {
  DbTransaction,
  MetaAccount as MetaAccountRow,
  MetaConversation as MetaConversationRow,
} from '@helpdock/db';
import type { JobLogger, MetaProfileFetchPayload } from '@helpdock/jobs';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from './meta.repository.js';
import type { MetaAccountFailure } from './meta-account-failure.js';
import {
  createMetaProfileHandler,
  createMetaProfileProcessor,
  type MetaProfileDependencies,
} from './meta-profile.job.js';

/**
 * The three steps of `meta.profile_fetch` against doubles: the transaction that
 * reads, the Graph call with no transaction open, and the transaction that
 * claims the receipt and writes. The same job against the stand-in, a database
 * and the outbox is in `meta-instagram.integration.test.ts` and
 * `meta-messenger.integration.test.ts`.
 */

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const ACCOUNT = '01937f5e-7e53-7000-8000-000000000010';
const CONVERSATION = '01937f5e-7e53-7000-8000-000000000020';
const CUSTOMER = '1784140000000001';
const TOKEN = 'EAAGprofile-job-token-0123456789';
const RECEIPT = `meta.profile_fetch:${CONVERSATION}`;
const NOW = new Date('2026-10-11T10:00:00.000Z');

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') });
// Encrypted once: each encryption draws its own nonce, and the rows are compared whole.
const CIPHERTEXT = encryptSecret(TOKEN, keyring);

const payload = (overrides: Partial<MetaProfileFetchPayload> = {}): MetaProfileFetchPayload => ({
  brandId: BRAND,
  conversationId: CONVERSATION,
  accountId: ACCOUNT,
  platform: 'instagram',
  ...overrides,
});

const accountRow = (overrides: Partial<MetaAccountRow> = {}): MetaAccountRow =>
  ({
    id: ACCOUNT,
    brandId: BRAND,
    platform: 'instagram',
    accessToken: CIPHERTEXT,
    ...overrides,
  }) as MetaAccountRow;

const conversationRow = (overrides: Partial<MetaConversationRow> = {}): MetaConversationRow =>
  ({
    id: CONVERSATION,
    brandId: BRAND,
    accountId: ACCOUNT,
    customerId: CUSTOMER,
    profileName: null,
    username: null,
    profileCheckedAt: null,
    ...overrides,
  }) as MetaConversationRow;

interface Scenario {
  readonly platform?: 'instagram' | 'messenger';
  /** What `GET /{customer id}` answers, or the failure it raises. */
  readonly answer?: unknown;
  readonly conversation?: MetaConversationRow | undefined | 'gone';
  readonly account?: MetaAccountRow | undefined | 'gone';
  /** The conversation the second transaction reads, when Graph took long enough to change it. */
  readonly afterGraph?: MetaConversationRow;
  readonly claimed?: boolean;
  readonly recordingFails?: boolean;
}

const run = async (scenario: Scenario = {}) => {
  const platform = scenario.platform ?? 'instagram';
  const tx = {} as DbTransaction;
  const logged: { level: string; fields: unknown; message: string }[] = [];
  const log: JobLogger = {
    info: (fields, message) => void logged.push({ level: 'info', fields, message }),
    warn: (fields, message) => void logged.push({ level: 'warn', fields, message }),
    error: (fields, message) => void logged.push({ level: 'error', fields, message }),
  };
  const writes: unknown[][] = [];
  const failures: MetaAccountFailure[] = [];
  const graphCalls: unknown[][] = [];
  // How many transactions were open when Graph was asked, and how many were opened in all.
  const openDuringGraph: number[] = [];
  let open = 0;
  let opened = 0;
  let conversationReads = 0;

  const conversation =
    scenario.conversation === 'gone' ? undefined : (scenario.conversation ?? conversationRow());
  const account =
    scenario.account === 'gone' ? undefined : (scenario.account ?? accountRow({ platform }));
  const claimed = new Set<string>(scenario.claimed === true ? [RECEIPT] : []);

  const repository = {
    account: async () => account,
    conversationById: async () => {
      conversationReads += 1;
      return conversationReads > 1 && scenario.afterGraph !== undefined
        ? scenario.afterGraph
        : conversation;
    },
    recordProfile: async (...args: unknown[]) =>
      void writes.push(['recordProfile', ...args.slice(1)]),
    recordProfileCheck: async (...args: unknown[]) =>
      void writes.push(['recordProfileCheck', ...args.slice(1)]),
  } as unknown as MetaProfileDependencies['repository'];

  const answer = scenario.answer ?? { id: CUSTOMER, name: 'Sheena Nelson', username: 'sheena.n' };
  const graph = {
    get: async (...args: unknown[]) => {
      openDuringGraph.push(open);
      graphCalls.push(args);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  } as unknown as GraphClient;

  const handler = createMetaProfileHandler({
    repository,
    keyring,
    graph,
    transaction: async (_brandId, work) => {
      open += 1;
      opened += 1;
      try {
        return await work(tx);
      } finally {
        open -= 1;
      }
    },
    claim: async (_tx, key) => {
      if (claimed.has(key)) {
        return false;
      }
      claimed.add(key);
      return true;
    },
    recordAccountFailure: async (_brandId, _accountId, failure) => {
      if (scenario.recordingFails === true) {
        throw Object.assign(new Error('update "meta_accounts" set "last_error" = $1 -- Sheena'), {
          code: '57P01',
        });
      }
      failures.push(failure);
    },
    now: () => NOW,
  });

  const result = await handler({ payload: payload({ platform }), log, receipt: RECEIPT }).then(
    () => ({ threw: undefined as unknown }),
    (error: unknown) => ({ threw: error }),
  );

  return { ...result, writes, failures, graphCalls, openDuringGraph, opened, logged, tx };
};

describe('a customer’s name', () => {
  it('is read with no transaction open and written in a second one, with the receipt', async () => {
    const result = await run();

    expect(result.threw).toBeUndefined();
    expect(result.openDuringGraph).toEqual([0]);
    expect(result.opened).toBe(2);
    expect(result.writes).toEqual([
      [
        'recordProfile',
        { conversation: conversationRow(), account: accountRow() },
        { name: 'Sheena Nelson', username: 'sheena.n' },
        NOW,
      ],
    ]);
  });

  it('is asked of Instagram with its own root and fields, and of Messenger with Graph’s', async () => {
    const instagram = await run();
    const messenger = await run({
      platform: 'messenger',
      answer: { id: CUSTOMER, first_name: 'Omar', last_name: 'Khalil' },
    });

    expect(instagram.graphCalls).toEqual([
      [`/${CUSTOMER}`, { token: TOKEN, api: 'instagram', query: { fields: 'name,username' } }],
    ]);
    expect(messenger.graphCalls).toEqual([
      [`/${CUSTOMER}`, { token: TOKEN, api: 'graph', query: { fields: 'first_name,last_name' } }],
    ]);
    expect(messenger.writes[0]?.[2]).toEqual({ name: 'Omar Khalil', username: null });
  });

  it('is recorded as asked when Graph has nothing to say', async () => {
    const result = await run({ answer: { id: CUSTOMER } });

    expect(result.threw).toBeUndefined();
    expect(result.writes).toEqual([['recordProfileCheck', CONVERSATION, NOW]]);
  });

  it('is recorded as asked, and stored as nothing, when Meta refuses the read', async () => {
    const refusal = new GraphApiFailure('permission', '10: Application does not have permission', {
      status: 403,
      code: 10,
    });
    const result = await run({ answer: refusal });

    expect(result.threw).toBeUndefined();
    expect(result.writes).toEqual([['recordProfileCheck', CONVERSATION, NOW]]);
    expect(result.logged).toContainEqual({
      level: 'warn',
      fields: expect.objectContaining({ accountId: ACCOUNT, reason: 'permission', code: 10 }),
      message: 'meta profile read refused; the customer keeps no name',
    });
    expect(JSON.stringify(result.logged)).not.toContain(TOKEN);
  });
});

describe('a lookup that Graph cannot answer now', () => {
  it.each(['retry', 'rate_limited'] as const)(
    'throws after a %s failure, writes nothing and claims nothing, so the next attempt starts over',
    async (kind) => {
      const failure = new GraphApiFailure(kind, 'HTTP 503: unavailable', { status: 503 });
      const result = await run({ answer: failure });

      expect(result.threw).toBe(failure);
      expect(result.writes).toEqual([]);
      expect(result.opened).toBe(1);
    },
  );

  it('marks the account at once when its token is dead, then throws for the retry', async () => {
    const dead = new GraphApiFailure('token_dead', '190: Invalid OAuth access token', {
      status: 401,
      code: 190,
    });
    const result = await run({ answer: dead });

    expect(result.failures).toEqual([{ kind: 'token_dead', detail: dead.detail }]);
    expect(result.threw).toBe(dead);
    expect(result.writes).toEqual([]);
  });

  it('still throws Graph’s failure when the account could not be marked, and says so', async () => {
    const dead = new GraphApiFailure('token_dead', '190: Invalid OAuth access token', {
      status: 401,
      code: 190,
    });
    const result = await run({ answer: dead, recordingFails: true });

    expect(result.threw).toBe(dead);
    expect(result.logged).toContainEqual({
      level: 'error',
      fields: expect.objectContaining({ accountId: ACCOUNT, errorClass: 'Error', code: '57P01' }),
      message: 'could not mark a meta account token_expired',
    });
    // A failed query's message quotes what it was writing: only its class and code are said.
    expect(JSON.stringify(result.logged)).not.toContain('Sheena');
  });

  it('throws what is not Graph’s failure, because it is a bug', async () => {
    const bug = new TypeError('boom');
    const result = await run({ answer: bug });

    expect(result.threw).toBe(bug);
  });
});

describe('a lookup with nothing to read', () => {
  it.each([
    ['the conversation is gone', { conversation: 'gone' }, 'conversation-gone'],
    ['the account is gone', { account: 'gone' }, 'account-gone'],
    [
      'the conversation is with another account',
      { conversation: conversationRow({ accountId: '01937f5e-7e53-7000-8000-0000000000ff' }) },
      'wrong-account',
    ],
    [
      'the conversation is already named',
      { conversation: conversationRow({ profileName: 'Sheena Nelson' }) },
      'answered',
    ],
    [
      'the conversation was already asked',
      { conversation: conversationRow({ profileCheckedAt: NOW }) },
      'answered',
    ],
  ] as const satisfies readonly (readonly [string, Scenario, string])[])(
    'does nothing when %s',
    async (_what, scenario, reason) => {
      const result = await run(scenario);

      expect(result.threw).toBeUndefined();
      expect(result.graphCalls).toEqual([]);
      expect(result.writes).toEqual([]);
      expect(result.opened).toBe(1);
      expect(result.logged).toContainEqual({
        level: 'info',
        fields: expect.objectContaining({ reason }),
        message: 'meta profile lookup skipped',
      });
    },
  );
});

describe('a lookup that raced another', () => {
  it('writes nothing when a delivery that ran first has claimed the receipt', async () => {
    const result = await run({ claimed: true });

    expect(result.threw).toBeUndefined();
    expect(result.writes).toEqual([]);
  });

  it('writes nothing when the conversation was answered while Graph was asked', async () => {
    const result = await run({ afterGraph: conversationRow({ profileName: 'Omar Khalil' }) });

    expect(result.threw).toBeUndefined();
    expect(result.writes).toEqual([]);
    expect(result.logged).toContainEqual({
      level: 'info',
      fields: { conversationId: CONVERSATION },
      message: 'the conversation was answered while Graph was asked',
    });
  });
});

describe('createMetaProfileProcessor', () => {
  const processor = createMetaProfileProcessor({
    db: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    repository: {} as unknown as MetaRepository,
    keyring,
    graph: {} as GraphClient,
    recordAccountFailure: async () => undefined,
  });

  it('fails a job of another name, one without an id and one with no conversation for good', async () => {
    await expect(processor({ name: 'meta.send', id: '1', data: {} } as never)).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(
      processor({ name: 'meta.profile_fetch', data: payload() } as never),
    ).rejects.toThrow(UnrecoverableError);
    await expect(
      processor({ name: 'meta.profile_fetch', id: '1', data: { brandId: BRAND } } as never),
    ).rejects.toThrow(UnrecoverableError);
  });
});
