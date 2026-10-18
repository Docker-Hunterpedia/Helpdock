import type { LookupAddress } from '@helpdock/net';

/** The Zendesk stand-in redirects to a separate test host, preserving the real credential boundary. */
export async function localVendorLookup(hostname: string): Promise<readonly LookupAddress[]> {
  if (!['cdn.zendesk.test', 'localhost', '127.0.0.1'].includes(hostname))
    throw new Error('Unexpected vendor fixture host');
  return [{ address: '127.0.0.1', family: 4 }];
}
