import type { LookupFunction } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
import { inspectDestination } from './outbound-destination.js';

const resolvingTo =
  (address: string): LookupFunction =>
  async () => [{ address, family: address.includes(':') ? 6 : 4 }];

const unresolvable: LookupFunction = async () => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
};

describe('inspectDestination', () => {
  it('has no complaint about a public https address', async () => {
    await expect(
      inspectDestination('https://api.example.com/v1', { lookup: resolvingTo('93.184.216.34') }),
    ).resolves.toBeUndefined();
  });

  it('names the address of a blocked range', async () => {
    await expect(
      inspectDestination('https://internal.example/v1', { lookup: resolvingTo('10.0.4.12') }),
    ).resolves.toEqual({ kind: 'destination-blocked', address: '10.0.4.12' });
    await expect(inspectDestination('https://169.254.169.254/v1', {})).resolves.toEqual({
      kind: 'destination-blocked',
      address: '169.254.169.254',
    });
  });

  it('asks for https unless the operator allowed the address', async () => {
    await expect(
      inspectDestination('http://api.example.com/v1', { lookup: resolvingTo('93.184.216.34') }),
    ).resolves.toEqual({ kind: 'https-required' });
    await expect(
      inspectDestination('http://ollama:11434/v1', {
        lookup: resolvingTo('172.18.0.5'),
        allowCidrs: ['172.16.0.0/12'],
      }),
    ).resolves.toBeUndefined();
  });

  it('lets an https name that does not resolve yet through, but not an http one', async () => {
    await expect(
      inspectDestination('https://not-yet.example.com', { lookup: unresolvable }),
    ).resolves.toBeUndefined();
    await expect(
      inspectDestination('http://not-yet.example.com', { lookup: unresolvable }),
    ).resolves.toEqual({ kind: 'https-required' });
  });
});
