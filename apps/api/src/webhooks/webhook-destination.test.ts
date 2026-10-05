import type { LookupFunction } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
import { createWebhookDestinationCheck } from './webhook-destination.js';

const resolvingTo =
  (address: string): LookupFunction =>
  async () => [{ address, family: address.includes(':') ? 6 : 4 }];

const unresolvable: LookupFunction = async () => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
};

describe('createWebhookDestinationCheck', () => {
  it('lets a public https endpoint through', async () => {
    const check = createWebhookDestinationCheck({ lookup: resolvingTo('93.184.216.34') });

    await expect(check('https://hooks.example.com/helpdock')).resolves.toBeUndefined();
  });

  it('refuses a name that resolves to a private address, and says which', async () => {
    const check = createWebhookDestinationCheck({ lookup: resolvingTo('10.0.4.12') });

    await expect(check('https://billing.internal.example/hooks')).rejects.toMatchObject({
      reason: 'webhook-destination-blocked',
      address: '10.0.4.12',
    });
  });

  it('refuses plain http to a public address', async () => {
    const check = createWebhookDestinationCheck({ lookup: resolvingTo('93.184.216.34') });

    await expect(check('http://hooks.example.com/helpdock')).rejects.toMatchObject({
      reason: 'webhook-https-required',
    });
  });

  it('allows plain http to a range the operator allowed', async () => {
    const check = createWebhookDestinationCheck({
      lookup: resolvingTo('10.0.4.12'),
      allowCidrs: ['10.0.0.0/8'],
    });

    await expect(check('http://billing.internal.example/hooks')).resolves.toBeUndefined();
  });

  it('lets an https name that does not resolve yet through, but not an http one', async () => {
    const check = createWebhookDestinationCheck({ lookup: unresolvable });

    await expect(check('https://not-yet.example.com/hooks')).resolves.toBeUndefined();
    await expect(check('http://not-yet.example.com/hooks')).rejects.toMatchObject({
      reason: 'webhook-https-required',
    });
  });
});
