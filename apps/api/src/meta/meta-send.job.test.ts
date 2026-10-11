import { GraphApiFailure } from '@helpdock/channels';
import type { DbTransaction, MetaDelivery } from '@helpdock/db';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import type { MetaRepository } from './meta.repository.js';
import {
  MetaFileNotReadyError,
  MetaSendRefusal,
  MetaWindowClosedError,
  recordSendFailure,
} from './meta-send.job.js';

const tx = {} as DbTransaction;
const at = new Date('2026-10-11T09:00:00.000Z');
const delivery = { id: 'delivery-1', accountId: 'account-1' } as MetaDelivery;

/** The repository calls a failure makes, in order, as `[method, ...what it was given]`. */
const record = async (error: unknown, job: Partial<Job> = {}) => {
  const calls: unknown[][] = [];
  const note =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args.slice(1)]);
    };
  const repository = {
    markRefused: note('markRefused'),
    recordFailure: note('recordFailure'),
    markError: note('markError'),
    update: note('update'),
  } as unknown as MetaRepository;

  await recordSendFailure({
    repository,
    tx,
    delivery,
    error,
    job: { attemptsMade: 0, opts: { attempts: 5 }, ...job } as Job,
    at,
  });

  return calls;
};

const graph = (
  kind: ConstructorParameters<typeof GraphApiFailure>[0],
  code: number | null,
  subcode: number | null = null,
) =>
  new GraphApiFailure(kind, `${String(code)}: Graph said no`, {
    code,
    subcode,
    status: 400,
  });

describe('recordSendFailure: what a failed attempt leaves, by what Graph said (brief §1.3)', () => {
  it('refuses a delivery whose window closed, with the platform’s code, and leaves the account alone', async () => {
    expect(await record(new MetaWindowClosedError('whatsapp'))).toEqual([
      [
        'markRefused',
        'delivery-1',
        {
          errorCode: '131047',
          error: 'The reply window had closed, so the reply was not sent',
          at,
        },
      ],
    ]);
  });

  it('refuses a delivery Graph itself says is outside the window, in Graph’s words and code', async () => {
    const failure = graph('window_closed', 10, 2_018_278);

    expect(await record(new MetaWindowClosedError('messenger', failure))).toEqual([
      ['markRefused', 'delivery-1', { errorCode: '10/2018278', error: '10: Graph said no', at }],
    ]);
  });

  it.each([
    ['retry', 1],
    ['rate_limited', 131_056],
  ] as const)(
    'counts a %s attempt and leaves the delivery queued until the fifth',
    async (kind, code) => {
      const calls = await record(graph(kind, code), { attemptsMade: 1 });

      expect(calls).toEqual([
        [
          'recordFailure',
          'delivery-1',
          {
            attempts: 2,
            error: `${String(code)}: Graph said no`,
            errorCode: String(code),
            dead: false,
            at,
          },
        ],
        ['markError', 'account-1', `${String(code)}: Graph said no`, at],
      ]);
    },
  );

  it('ends the delivery on the fifth attempt of a fault that did not clear', async () => {
    const calls = await record(graph('retry', 2), { attemptsMade: 4 });

    expect(calls[0]).toEqual([
      'recordFailure',
      'delivery-1',
      expect.objectContaining({ attempts: 5, dead: true }),
    ]);
  });

  it.each([
    ['permanent', 551],
    ['permission', 200],
    ['account_restricted', 131_031],
  ] as const)('fails a %s refusal at once and records it on the account', async (kind, code) => {
    const calls = await record(new MetaSendRefusal(graph(kind, code)), { attemptsMade: 0 });

    expect(calls).toEqual([
      [
        'recordFailure',
        'delivery-1',
        {
          attempts: 1,
          error: `${String(code)}: Graph said no`,
          errorCode: String(code),
          dead: true,
          at,
        },
      ],
      ['markError', 'account-1', `${String(code)}: Graph said no`, at],
    ]);
  });

  it('fails a dead token at once and marks the account token_expired instead of just noting it', async () => {
    const calls = await record(new MetaSendRefusal(graph('token_dead', 190, 463)));

    expect(calls).toEqual([
      [
        'recordFailure',
        'delivery-1',
        expect.objectContaining({ dead: true, errorCode: '190/463' }),
      ],
      [
        'update',
        'account-1',
        { status: 'token_expired', lastError: '190: Graph said no', lastErrorAt: at },
      ],
    ]);
  });

  it('keeps Graph’s sentence to what last_error holds', async () => {
    const long = new GraphApiFailure('retry', 'x'.repeat(500), { code: 1, status: 500 });

    const calls = await record(long);

    const recorded = calls[0]?.[2] as { error: string };
    expect(recorded.error).toHaveLength(300);
  });

  it('does not blame Meta for a fault that was ours, or for a file still being processed', async () => {
    for (const [error, text] of [
      [new Error('connection terminated'), 'The reply could not be sent'],
      [new MetaFileNotReadyError(), 'An attachment of the reply is still being processed'],
    ] as const) {
      expect(await record(error)).toEqual([
        [
          'recordFailure',
          'delivery-1',
          { attempts: 1, error: text, errorCode: null, dead: false, at },
        ],
      ]);
    }
  });

  it('ends a delivery for good on an unrecoverable error that is not Meta’s either', async () => {
    const calls = await record(new UnrecoverableError('payload is wrong'));

    expect(calls).toEqual([
      [
        'recordFailure',
        'delivery-1',
        expect.objectContaining({ dead: true, error: 'The reply could not be sent' }),
      ],
    ]);
  });
});
