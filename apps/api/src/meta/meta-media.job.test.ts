import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GraphApiFailure, type GraphClient } from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import type { DbTransaction, MetaAccount } from '@helpdock/db';
import type { JobLogger, MetaMediaFetchPayload } from '@helpdock/jobs';
import { DEFAULT_CONTENT_POLICY, type MetaFileRef } from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  attachmentRow,
  FakeStorage,
  fakeRepository,
  fakeTx,
  type OutboxRow,
  policyWith,
} from '../testing/media.js';
import {
  createMetaMediaFetchHandler,
  type MetaAccountFailure,
  matchesDigest,
  sizeCap,
} from './meta-media.job.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';
const ACCOUNT = '01937f5e-7e53-7000-8000-000000000010';
const KEY = `brands/${BRAND}/tickets/${TICKET}/${ATTACHMENT}/original`;
const TOKEN = 'EAAGunit-test-token-0123456789';
const MEDIA_URL =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1479537139650973&signature=SECRET';
const CDN_URL = 'https://scontent.xx.fbcdn.net/v/t1.15752-9/12345_n.jpg?oh=SIGNED';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });
const bytes = Buffer.from('not really a jpeg, the pipeline sniffs it later');
const digestOf = (body: Uint8Array, encoding: 'base64' | 'hex'): string =>
  createHash('sha256').update(body).digest(encoding);

const image = (overrides: Partial<Extract<MetaFileRef, { kind: 'whatsapp_media' }>> = {}) =>
  ({
    kind: 'whatsapp_media',
    type: 'image',
    mediaId: '1479537139650973',
    mimeType: 'image/jpeg',
    sha256: digestOf(bytes, 'base64'),
    ...overrides,
  }) satisfies MetaFileRef;

const link = (type: string): MetaFileRef => ({ kind: 'cdn_url', url: CDN_URL, type });

interface Scenario {
  readonly ref?: MetaFileRef;
  /** What `GET /{media-id}` answers, or the failure it raises. */
  readonly description?: unknown;
  /** What the download answers, or the failure it raises. */
  readonly download?: { bytes: Buffer; contentType: string | null } | Error;
  readonly attempt?: number;
  readonly policy?: ReturnType<typeof policyWith>;
  readonly row?: Partial<ReturnType<typeof attachmentRow>>;
  readonly account?: 'present' | 'gone';
  /** The attachment was deleted (with its ticket, say) while the job waited. */
  readonly attachment?: 'present' | 'gone';
  readonly storageFails?: boolean;
}

const run = async (scenario: Scenario = {}) => {
  const ref = scenario.ref ?? image();
  const state = {
    row: attachmentRow({
      id: ATTACHMENT,
      brandId: BRAND,
      ticketId: TICKET,
      s3Key: KEY,
      status: 'pending',
      kind: 'image',
      mime: 'image/jpeg',
      size: 0,
      ...scenario.row,
    }),
    policy: scenario.policy ?? DEFAULT_CONTENT_POLICY,
  };
  const storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-meta-media-')));
  const outbox: OutboxRow[] = [];
  const calls: { method: 'get' | 'download'; args: unknown[] }[] = [];
  const recorded: MetaAccountFailure[] = [];
  const logged: unknown[] = [];

  const description = scenario.description ?? {
    id: '1479537139650973',
    url: MEDIA_URL,
    mime_type: 'image/jpeg',
    sha256: digestOf(bytes, 'hex'),
    file_size: String(bytes.length),
  };
  const downloaded = scenario.download ?? { bytes, contentType: 'image/jpeg' };
  const graph = {
    get: async (...args: unknown[]) => {
      calls.push({ method: 'get', args });
      if (description instanceof Error) {
        throw description;
      }
      return description;
    },
    download: async (...args: unknown[]) => {
      calls.push({ method: 'download', args });
      if (downloaded instanceof Error) {
        throw downloaded;
      }
      return downloaded;
    },
  } as unknown as GraphClient;

  const account = {
    id: ACCOUNT,
    brandId: BRAND,
    accessToken: encryptSecret(TOKEN, keyring),
  } as unknown as MetaAccount;
  const failingStorage = {
    upload: async () => {
      throw new Error('the bucket is down');
    },
  };
  const record = (message: unknown) => {
    logged.push(message);
  };
  const log: JobLogger = {
    info: (fields, message) => record({ fields, message }),
    warn: (fields, message) => record({ fields, message }),
    error: (fields, message) => record({ fields, message }),
  };

  const handler = createMetaMediaFetchHandler({
    storage: scenario.storageFails === true ? failingStorage : storage,
    graph: () => graph,
    keyring,
    repository: {
      account: async () => (scenario.account === 'gone' ? undefined : account),
    },
    media: {
      ...fakeRepository(state),
      find: async () => (scenario.attachment === 'gone' ? undefined : state.row),
    },
    recordAccountFailure: async (_brand, _account, failure) => {
      recorded.push(failure);
    },
    now: () => new Date('2026-10-11T10:00:00Z'),
  });
  const payload: MetaMediaFetchPayload = {
    brandId: BRAND,
    attachmentId: ATTACHMENT,
    accountId: ACCOUNT,
    ref,
  };
  const attemptsMade = scenario.attempt ?? 0;
  const result = await handler({
    payload,
    brandId: BRAND,
    tx: fakeTx(outbox) as DbTransaction,
    job: { attemptsMade, opts: { attempts: 5 } } as unknown as Job,
    log,
  }).then(
    () => ({ threw: undefined as unknown }),
    (error: unknown) => ({ threw: error }),
  );

  return { ...result, state, storage, outbox, calls, recorded, logged };
};

const LAST = 4;

describe('a WhatsApp file', () => {
  it('is fetched with the account’s token, checked, stored and handed to the pipeline', async () => {
    const result = await run();

    expect(result.threw).toBeUndefined();
    expect(await result.storage.read(KEY)).toEqual(bytes);
    expect(result.state.row).toMatchObject({
      status: 'processing',
      size: bytes.length,
      mime: 'image/jpeg',
      kind: 'image',
      originalName: 'image.jpg',
    });
    expect(result.outbox).toEqual([
      {
        brandId: BRAND,
        event: 'attachment.uploaded',
        payload: { attachmentId: ATTACHMENT, ticketId: TICKET },
      },
    ]);
    expect(result.calls).toEqual([
      { method: 'get', args: ['/1479537139650973', { token: TOKEN }] },
      {
        method: 'download',
        args: [
          MEDIA_URL,
          expect.objectContaining({
            token: TOKEN,
            maxBytes: DEFAULT_CONTENT_POLICY.image.maxBytes,
          }),
        ],
      },
    ]);
  });

  it('is rejected as unreadable when the bytes are not the ones Meta described', async () => {
    const result = await run({
      download: { bytes: Buffer.from('somebody else’s file'), contentType: 'image/jpeg' },
    });

    expect(result.threw).toBeUndefined();
    expect(result.state.row).toMatchObject({ status: 'rejected', rejectReason: 'unreadable' });
    await expect(result.storage.read(KEY)).rejects.toThrow();
    expect(result.outbox).toEqual([
      expect.objectContaining({
        event: 'attachment.ready',
        payload: expect.objectContaining({ attachmentId: ATTACHMENT, status: 'rejected' }),
      }),
    ]);
  });

  it('falls back to the digest Graph gave when the webhook carried none', async () => {
    const trusted = await run({ ref: image({ sha256: null }) });
    expect(trusted.state.row.status).toBe('processing');

    const wrong = await run({
      ref: image({ sha256: null }),
      description: {
        id: '1479537139650973',
        url: MEDIA_URL,
        sha256: digestOf(Buffer.from('another file'), 'hex'),
      },
    });
    expect(wrong.state.row).toMatchObject({ status: 'rejected', rejectReason: 'unreadable' });
  });

  it('is not downloaded when Graph already says it is over the cap', async () => {
    const result = await run({
      description: {
        id: '1479537139650973',
        url: MEDIA_URL,
        file_size: String(DEFAULT_CONTENT_POLICY.image.maxBytes + 1),
      },
    });

    expect(result.state.row).toMatchObject({ status: 'rejected', rejectReason: 'too_large' });
    expect(result.calls.map((call) => call.method)).toEqual(['get']);
  });

  it('is rejected as too large when the download outgrows the cap on the way in', async () => {
    const result = await run({
      download: new GraphApiFailure('permanent', 'The response is too large', {
        reason: 'too-large',
      }),
    });

    expect(result.threw).toBeUndefined();
    expect(result.state.row).toMatchObject({ status: 'rejected', rejectReason: 'too_large' });
  });

  it('is measured against the policy as it stands when the bytes arrive', async () => {
    const result = await run({
      policy: policyWith({
        image: { enabled: true, maxBytes: 8, allowedMime: ['image/jpeg'] },
      }),
      description: { id: '1479537139650973', url: MEDIA_URL },
    });

    expect(result.state.row).toMatchObject({ status: 'rejected', rejectReason: 'too_large' });
    await expect(result.storage.read(KEY)).rejects.toThrow();
  });

  it('is capped by the brand’s cap for its kind: a video may weigh what an image may not', () => {
    expect(sizeCap(DEFAULT_CONTENT_POLICY, image())).toBe(DEFAULT_CONTENT_POLICY.image.maxBytes);
    expect(sizeCap(DEFAULT_CONTENT_POLICY, image({ type: 'video', mimeType: 'video/mp4' }))).toBe(
      DEFAULT_CONTENT_POLICY.video.maxBytes,
    );
  });

  it('is capped by the larger of the two for a story, whose kind is the server’s to say', () => {
    expect(sizeCap(DEFAULT_CONTENT_POLICY, link('story'))).toBe(
      Math.max(DEFAULT_CONTENT_POLICY.image.maxBytes, DEFAULT_CONTENT_POLICY.video.maxBytes),
    );
  });
});

describe('a link in a Messenger or Instagram payload', () => {
  it('is fetched without the token and takes the type the server answered with', async () => {
    const result = await run({
      ref: link('image'),
      row: { mime: 'application/octet-stream', originalName: 'image' },
      download: { bytes, contentType: 'image/jpeg; charset=binary' },
    });

    expect(result.state.row).toMatchObject({
      status: 'processing',
      mime: 'image/jpeg',
      kind: 'image',
      originalName: 'image.jpg',
    });
    expect(result.calls).toEqual([
      {
        method: 'download',
        args: [CDN_URL, expect.not.objectContaining({ token: expect.anything() })],
      },
    ]);
    expect(JSON.stringify(result.calls)).not.toContain(TOKEN);
  });

  it('takes a story’s kind from the server: a video story is a video', async () => {
    const result = await run({
      ref: link('story'),
      row: { mime: 'application/octet-stream' },
      download: { bytes, contentType: 'video/mp4' },
    });

    expect(result.state.row).toMatchObject({
      status: 'processing',
      kind: 'video',
      mime: 'video/mp4',
      originalName: 'story.mp4',
    });
  });

  it('is rejected when the server answers with a type the kind does not allow', async () => {
    const result = await run({
      ref: link('image'),
      download: { bytes, contentType: 'text/html' },
    });

    expect(result.state.row).toMatchObject({
      status: 'rejected',
      rejectReason: 'mime_not_allowed',
    });
    await expect(result.storage.read(KEY)).rejects.toThrow();
  });

  it('is rejected when the server names no type at all', async () => {
    const result = await run({ ref: link('image'), download: { bytes, contentType: null } });

    expect(result.state.row).toMatchObject({
      status: 'rejected',
      rejectReason: 'mime_not_allowed',
    });
  });

  it('is never fetched from a host that is not Meta’s', async () => {
    const result = await run({
      ref: link('image'),
      download: new GraphApiFailure('permanent', 'evil.example is not a Meta host', {
        reason: 'host-not-allowed',
      }),
    });

    expect(result.threw).toBeUndefined();
    expect(result.state.row).toMatchObject({
      status: 'rejected',
      rejectReason: 'processing_failed',
    });
  });
});

describe('a file Meta no longer has', () => {
  const missing = new GraphApiFailure('permanent', 'HTTP 404: Not Found', { status: 404 });

  it('is asked for again, on every attempt but the last', async () => {
    for (const attempt of [0, 1, 2, 3]) {
      const result = await run({ attempt, download: missing });

      expect(result.threw).toBe(missing);
      expect(result.state.row.status).toBe('pending');
      expect(result.outbox).toEqual([]);
    }
  });

  it('is rejected as missing on the last attempt, so it is never left pending', async () => {
    const result = await run({ attempt: LAST, download: missing });

    expect(result.threw).toBeUndefined();
    expect(result.state.row).toMatchObject({ status: 'rejected', rejectReason: 'object_missing' });
  });

  it('is the same whether Graph answers 404 or says the object does not exist', async () => {
    const gone = new GraphApiFailure('permanent', '100/33: Object does not exist', {
      status: 400,
      code: 100,
      subcode: 33,
    });

    expect((await run({ description: gone })).threw).toBe(gone);
    expect((await run({ description: gone, attempt: LAST })).state.row).toMatchObject({
      rejectReason: 'object_missing',
    });
  });
});

describe('a token Meta no longer accepts', () => {
  const dead = new GraphApiFailure('token_dead', '190: Invalid OAuth access token', {
    status: 401,
    code: 190,
  });

  it('marks the account at once and asks again, because the operator may be pasting a new one', async () => {
    const result = await run({ description: dead });

    expect(result.recorded).toEqual([{ kind: 'token_dead', detail: dead.detail }]);
    expect(result.threw).toBe(dead);
    expect(result.state.row.status).toBe('pending');
  });

  it('gives up on the last attempt without leaving the file pending', async () => {
    const result = await run({ description: dead, attempt: LAST });

    expect(result.recorded).toEqual([{ kind: 'token_dead', detail: dead.detail }]);
    expect(result.threw).toBeUndefined();
    expect(result.state.row).toMatchObject({
      status: 'rejected',
      rejectReason: 'processing_failed',
    });
  });

  it('is told to the account in Graph’s words and never the token', async () => {
    const result = await run({ description: dead });

    expect(JSON.stringify(result.recorded)).not.toContain(TOKEN);
    expect(JSON.stringify(result.logged)).not.toContain(TOKEN);
  });
});

describe('a refusal that no retry fixes', () => {
  it.each(['permission', 'account_restricted'] as const)(
    'on a %s failure notes it on the account and rejects at once',
    async (kind) => {
      const failure = new GraphApiFailure(kind, '200: Permission denied', {
        status: 403,
        code: 200,
      });
      const result = await run({ description: failure });

      expect(result.recorded).toEqual([{ kind: 'other', detail: failure.detail }]);
      expect(result.threw).toBeUndefined();
      expect(result.state.row).toMatchObject({
        status: 'rejected',
        rejectReason: 'processing_failed',
      });
    },
  );

  it('rejects at once when Graph refuses the request itself', async () => {
    const result = await run({
      description: new GraphApiFailure('permanent', '100: Invalid parameter', {
        status: 400,
        code: 100,
      }),
    });

    expect(result.threw).toBeUndefined();
    expect(result.state.row.rejectReason).toBe('processing_failed');
    expect(result.recorded).toEqual([]);
  });
});

describe('Graph or the network failing', () => {
  it.each(['retry', 'rate_limited'] as const)('asks again after a %s failure', async (kind) => {
    const failure = new GraphApiFailure(kind, 'HTTP 503: unavailable', { status: 503 });

    expect((await run({ download: failure })).threw).toBe(failure);
    expect((await run({ download: failure, attempt: LAST })).state.row).toMatchObject({
      status: 'rejected',
      rejectReason: 'processing_failed',
    });
  });

  it('reads a description it cannot parse as Graph failing, not as a verdict on the file', async () => {
    const result = await run({ description: { id: '1479537139650973', url: 'not a url' } });

    expect(result.threw).toBeInstanceOf(GraphApiFailure);
    expect(result.state.row.status).toBe('pending');
    expect((await run({ description: { url: 7 }, attempt: LAST })).state.row.status).toBe(
      'rejected',
    );
  });

  it('asks again after the bucket failed, and gives up on the last attempt', async () => {
    const first = await run({ storageFails: true });
    expect(first.threw).toBeInstanceOf(Error);
    expect(first.state.row.status).toBe('pending');

    const last = await run({ storageFails: true, attempt: LAST });
    expect(last.threw).toBeUndefined();
    expect(last.state.row).toMatchObject({ status: 'rejected', rejectReason: 'processing_failed' });
  });
});

describe('an attachment that is not there to fetch', () => {
  it('does nothing for one that was deleted with its ticket', async () => {
    const result = await run({ attachment: 'gone' });

    expect(result.threw).toBeUndefined();
    expect(result.calls).toEqual([]);
    expect(result.outbox).toEqual([]);
  });

  it('fetches nothing for one already past pending: a redelivery after the receipts were purged', async () => {
    const result = await run({ row: { status: 'ready' } });

    expect(result.calls).toEqual([]);
    expect(result.state.row.status).toBe('ready');
    expect(result.outbox).toEqual([]);
  });

  it('rejects one whose account was disconnected, as it can no longer fetch', async () => {
    const result = await run({ account: 'gone' });

    expect(result.calls).toEqual([]);
    expect(result.state.row).toMatchObject({
      status: 'rejected',
      rejectReason: 'processing_failed',
    });
  });
});

describe('matchesDigest', () => {
  const body = Buffer.from('hello');

  it('reads base64, as the webhook writes it, and hex, as Graph does', () => {
    expect(matchesDigest(body, digestOf(body, 'base64'))).toBe(true);
    expect(matchesDigest(body, digestOf(body, 'hex'))).toBe(true);
    expect(matchesDigest(body, digestOf(body, 'hex').toUpperCase())).toBe(true);
  });

  it('refuses a different file, a truncated digest and nonsense', () => {
    expect(matchesDigest(Buffer.from('hellp'), digestOf(body, 'base64'))).toBe(false);
    expect(matchesDigest(body, digestOf(body, 'base64').slice(0, 20))).toBe(false);
    expect(matchesDigest(body, '')).toBe(false);
    expect(matchesDigest(body, '!!not a digest!!')).toBe(false);
  });
});
