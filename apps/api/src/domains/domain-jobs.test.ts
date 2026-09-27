import type { Db, DbTransaction } from '@helpdock/db';
import { type DomainVerifyPayload, silentLogger } from '@helpdock/jobs';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { createCheckRequestedHandler, createDomainsProcessor } from './domain-jobs.js';
import type { DomainVerifier } from './domain-verifier.js';

const brandId = '01924f00-0000-7000-8000-0000000000aa';
const domainId = '01924f00-0000-7000-8000-0000000000d1';
const outboxId = '01924f00-0000-7000-8000-000000000001';

const recorder = () => {
  const added: { payload: DomainVerifyPayload; jobId: string }[] = [];
  return {
    added,
    queue: {
      add: async (payload: DomainVerifyPayload, jobId: string) => {
        added.push({ payload, jobId });
      },
    },
  };
};

describe('domain.check_requested', () => {
  it('adds one check of that domain, keyed by the outbox row', async () => {
    const { added, queue } = recorder();

    await createCheckRequestedHandler(queue)({
      outboxId,
      brandId,
      event: 'domain.check_requested',
      payload: { domainId },
      tx: {} as DbTransaction,
      log: silentLogger,
    });

    expect(added).toEqual([{ payload: { brandId, domainId }, jobId: `domain.verify.${outboxId}` }]);
  });

  it('refuses a payload without a domain', async () => {
    const { queue } = recorder();

    await expect(
      createCheckRequestedHandler(queue)({
        outboxId,
        brandId,
        event: 'domain.check_requested',
        payload: {},
        tx: {} as DbTransaction,
        log: silentLogger,
      }),
    ).rejects.toThrow();
  });
});

describe('the domains processor', () => {
  const verifier = () =>
    ({
      checkOne: vi.fn(async () => 'verified'),
      checkDue: vi.fn(async () => 0),
    }) as unknown as DomainVerifier & {
      checkOne: ReturnType<typeof vi.fn>;
      checkDue: ReturnType<typeof vi.fn>;
    };

  it('checks the one domain a person asked about', async () => {
    const checks = verifier();
    const process = createDomainsProcessor({
      db: {} as Db,
      verifier: checks,
      queue: recorder().queue,
      log: silentLogger,
    });

    await process({ name: 'domain.verify', data: { brandId, domainId }, id: 'job-1' });

    expect(checks.checkOne).toHaveBeenCalledWith(brandId, domainId, 'job-1');
    expect(checks.checkDue).not.toHaveBeenCalled();
  });

  it('checks the brand’s due domains on a scheduled run', async () => {
    const checks = verifier();
    const process = createDomainsProcessor({
      db: {} as Db,
      verifier: checks,
      queue: recorder().queue,
      log: silentLogger,
    });

    await process({ name: 'domain.verify', data: { brandId } });

    expect(checks.checkDue).toHaveBeenCalledWith(brandId, 'domain.verify');
  });

  it('fails for good on a payload that will never parse, or a job it does not know', async () => {
    const process = createDomainsProcessor({
      db: {} as Db,
      verifier: verifier(),
      queue: recorder().queue,
      log: silentLogger,
    });

    await expect(
      process({ name: 'domain.verify', data: { brandId: 'nope' }, id: 'job-2' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(process({ name: 'domain.other', data: {}, id: 'job-3' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
