import type { DbTransaction } from '@helpdock/db';
import { MAX_HELPCENTER_DOMAINS } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import type { DomainsRepository } from './domains.repository.js';
import { DomainsService } from './domains.service.js';
import { DomainsFailure } from './domains-failure.js';

/**
 * The refusals decided before anything is written. Everything that writes —
 * the row, the outbox request, the audit row — is proved against Postgres in
 * `domains.integration.test.ts`.
 */

const context: TicketingContext = {
  tx: {} as DbTransaction,
  brandId: '01924f00-0000-7000-8000-0000000000aa',
  actor: { userId: '01924f00-0000-7000-8000-0000000000u1', role: 'admin', departmentIds: 'all' },
};

const serviceWith = (count = 0) => {
  const repository = {
    countForBrand: vi.fn(async () => count),
    insert: vi.fn(),
  };
  const service = new DomainsService({
    repository: repository as unknown as DomainsRepository,
    cnameTarget: 'edge.helpdock.com',
    reservedHosts: ['admin.helpdock.com'],
  });
  return { service, repository };
};

const refusalOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return error instanceof DomainsFailure ? error.reason : undefined;
};

describe('DomainsService.add refuses before writing', () => {
  it.each([
    ['https://support.acme.com', 'domain-invalid'],
    ['support.acme.com/help', 'domain-invalid'],
    ['10.0.0.5', 'domain-invalid'],
    ['support', 'domain-invalid'],
    ['printer.local', 'domain-not-public'],
    ['help.acme.test', 'domain-not-public'],
    ['EDGE.helpdock.com.', 'domain-reserved'],
    ['admin.helpdock.com', 'domain-reserved'],
  ])('%j as %s', async (domain, reason) => {
    const { service, repository } = serviceWith();

    expect(await refusalOf(service.add(context, { domain }))).toBe(reason);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('a brand that already has the most domains it may have', async () => {
    const { service, repository } = serviceWith(MAX_HELPCENTER_DOMAINS);

    expect(await refusalOf(service.add(context, { domain: 'help.acme.com' }))).toBe('domain-limit');
    expect(repository.insert).not.toHaveBeenCalled();
  });
});
