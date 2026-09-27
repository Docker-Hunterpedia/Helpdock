import { describe, expect, it } from 'vitest';
import { isDomainsError } from './api.js';
import { MockDomainsApi } from './mock-api.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const reasonOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return isDomainsError(error) ? error.reason : undefined;
};

describe('MockDomainsApi', () => {
  it('starts every brand with the artboard’s three domains', async () => {
    const { domains, cnameTarget } = await new MockDomainsApi().domains(BRAND);

    expect(cnameTarget).toBe('edge.helpdock.io');
    expect(domains.map((row) => [row.domain, row.state])).toEqual([
      ['help.helpdock.com', 'verified'],
      ['support.helpdock.com', 'pending'],
      ['help.helpdock.sa', 'failed'],
    ]);
  });

  it('adds a pending domain with its records', async () => {
    const api = new MockDomainsApi();

    const added = await api.addDomain(BRAND, ' Docs.Acme.com ');

    expect(added).toMatchObject({ domain: 'docs.acme.com', state: 'pending' });
    expect(added.records.txt.name).toBe('_helpdock.docs.acme.com');
    expect((await api.domains(BRAND)).domains).toHaveLength(4);
  });

  it('refuses what the api refuses', async () => {
    const api = new MockDomainsApi();

    expect(await reasonOf(api.addDomain(BRAND, 'https://x.com'))).toBe('domain-invalid');
    expect(await reasonOf(api.addDomain(BRAND, 'printer.local'))).toBe('domain-not-public');
    expect(await reasonOf(api.addDomain(BRAND, 'edge.helpdock.io'))).toBe('domain-reserved');
    expect(await reasonOf(api.addDomain(BRAND, 'help.helpdock.com'))).toBe('domain-taken');
    for (let index = 0; index < 7; index += 1) {
      await api.addDomain(BRAND, `h${index}.acme.com`);
    }
    expect(await reasonOf(api.addDomain(BRAND, 'one-more.acme.com'))).toBe('domain-limit');
  });

  it('checks, flags, moves primary and removes', async () => {
    const api = new MockDomainsApi(() => Date.parse('2026-09-27T12:00:00Z'));
    const [verified, pending, failed] = (await api.domains(BRAND)).domains;
    if (verified === undefined || pending === undefined || failed === undefined) {
      throw new Error('the fixture has three domains');
    }

    expect((await api.checkDomain(BRAND, pending.id)).lastCheckedAt).toBe(
      '2026-09-27T12:00:00.000Z',
    );
    expect(await reasonOf(api.updateDomain(BRAND, pending.id, { primary: true }))).toBe(
      'domain-not-verified',
    );
    expect(await api.updateDomain(BRAND, failed.id, { cloudflareProxied: true })).toMatchObject({
      state: 'verified',
      tls: 'cloudflare',
      failure: null,
    });
    await api.updateDomain(BRAND, failed.id, { primary: true });
    expect((await api.domains(BRAND)).domains.filter((row) => row.primary)).toHaveLength(1);

    await api.removeDomain(BRAND, verified.id);
    expect((await api.domains(BRAND)).domains).toHaveLength(2);
    await expect(api.removeDomain(BRAND, verified.id)).rejects.toThrow();
    await expect(api.checkDomain(BRAND, verified.id)).rejects.toThrow();
    await expect(api.updateDomain(BRAND, verified.id, { primary: true })).rejects.toThrow();
  });
});
