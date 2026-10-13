import { expect, it } from 'vitest';
import { oidcHttpLookup, oidcTransport } from './oidc-transport.js';

it('rejects a public address after an allowed private DNS answer changes', async () => {
  let calls = 0;
  const lookup = oidcHttpLookup(['127.0.0.0/8'], async () => [
    { address: calls++ === 0 ? '127.0.0.1' : '81.2.69.142', family: 4 },
  ]);
  expect(await lookup('idp.test')).toEqual([{ address: '127.0.0.1', family: 4 }]);
  await expect(lookup('idp.test')).rejects.toThrow('sso-https-required');
});

it('rejects mixed private/public DNS answers and empty answers', async () => {
  await expect(
    oidcHttpLookup(['127.0.0.0/8'], async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '81.2.69.142', family: 4 },
    ])('idp.test'),
  ).rejects.toThrow('sso-https-required');
  await expect(oidcHttpLookup([], async () => [])('idp.test')).rejects.toThrow(
    'sso-https-required',
  );
});

it('refuses public HTTP literals before sending any client credentials', async () => {
  await expect(
    oidcTransport([])('http://81.2.69.142/token', {
      method: 'POST',
      headers: {},
      redirect: 'manual',
      body: 'client_secret=fixture',
    }),
  ).rejects.toThrow('sso-https-required');
});

it('refuses unsupported request bodies rather than serializing them', async () => {
  await expect(
    oidcTransport([])('https://idp.test/token', {
      method: 'POST',
      headers: {},
      redirect: 'manual',
      body: new ReadableStream<Uint8Array>(),
    }),
  ).rejects.toThrow('sso-request-body-unsupported');
});
