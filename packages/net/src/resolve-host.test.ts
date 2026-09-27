import { describe, expect, it, vi } from 'vitest';
import { SafeFetchError } from './errors.js';
import type { LookupFunction } from './policy.js';
import { resolvePublicHost } from './resolve-host.js';

const lookupTo =
  (...addresses: string[]): LookupFunction =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

describe('resolvePublicHost', () => {
  it('returns the public address a name resolves to', async () => {
    await expect(
      resolvePublicHost('imap.example.com', { lookup: lookupTo('93.184.216.34') }),
    ).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('accepts a public IP literal, bracketed or not', async () => {
    await expect(resolvePublicHost('[2606:4700::1111]')).resolves.toMatchObject({ family: 6 });
    await expect(resolvePublicHost('1.1.1.1')).resolves.toMatchObject({ address: '1.1.1.1' });
  });

  it('refuses a private address and reports it', async () => {
    const onBlocked = vi.fn();
    const refusal = await resolvePublicHost('imap.internal', {
      lookup: lookupTo('93.184.216.34', '10.0.0.5'),
      onBlocked,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SafeFetchError);
    expect((refusal as SafeFetchError).code).toBe('destination-blocked');
    expect(onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'imap.internal', address: '10.0.0.5' }),
    );
  });

  it('lets an operator allow-list an internal range', async () => {
    await expect(
      resolvePublicHost('mail.lan', { lookup: lookupTo('10.0.0.5'), allowCidrs: ['10.0.0.0/8'] }),
    ).resolves.toMatchObject({ address: '10.0.0.5' });
  });

  it('refuses an empty or malformed host, and a name that does not resolve', async () => {
    await expect(resolvePublicHost('  ')).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(resolvePublicHost('a b')).rejects.toBeInstanceOf(SafeFetchError);
    await expect(
      resolvePublicHost('nowhere.invalid', {
        lookup: () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).rejects.toMatchObject({ code: 'dns-failure' });
  });
});
