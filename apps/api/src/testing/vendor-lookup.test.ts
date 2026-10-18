import { expect, it } from 'vitest';
import { localVendorLookup } from './vendor-lookup.js';

it('pins only the named test vendor hosts to the owned loopback stand-in', async () => {
  await expect(localVendorLookup('cdn.zendesk.test')).resolves.toEqual([
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(localVendorLookup('localhost')).resolves.toEqual([
    { address: '127.0.0.1', family: 4 },
  ]);
});
it.each(['cdn.zendesk.test.attacker.invalid', 'example.com', '169.254.169.254'])(
  'refuses an unrelated fixture lookup: %s',
  async (hostname) => {
    await expect(localVendorLookup(hostname)).rejects.toThrow('Unexpected vendor fixture host');
  },
);
