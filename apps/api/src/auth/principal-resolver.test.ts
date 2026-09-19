import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testing/silent-logger.js';
import {
  createPrincipalResolver,
  DEV_PRINCIPAL_ENV_KEY,
  DEV_PRINCIPAL_HEADER,
  DenyAllPrincipalResolver,
  devPrincipalHeaderEnabled,
  HeaderPrincipalResolver,
} from './principal-resolver.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const principal = {
  type: 'staff',
  id: USER,
  brands: { [BRAND]: { role: 'admin', departmentIds: 'all' } },
  installAdmin: false,
};

const requestWith = (value: unknown) => ({
  headers: { [DEV_PRINCIPAL_HEADER]: value } as Record<string, string | string[] | undefined>,
});

describe('HeaderPrincipalResolver', () => {
  const resolver = new HeaderPrincipalResolver();

  it('reads a principal out of the header', async () => {
    await expect(resolver.resolve(requestWith(JSON.stringify(principal)))).resolves.toEqual(
      principal,
    );
  });

  it.each([
    ['no header', undefined],
    ['an empty header', '   '],
    ['an array', ['{}', '{}']],
    ['a value that is not JSON', 'not json'],
    ['JSON that is not a principal', '{"type":"root"}'],
    ['a principal with a brand key that is not a uuid', '{"type":"staff","id":"x","brands":{}}'],
  ])('resolves nothing for %s', async (_case, value) => {
    await expect(resolver.resolve(requestWith(value))).resolves.toBeNull();
  });
});

describe('DenyAllPrincipalResolver', () => {
  it('never authenticates anything', async () => {
    await expect(new DenyAllPrincipalResolver().resolve()).resolves.toBeNull();
  });
});

describe('devPrincipalHeaderEnabled', () => {
  it('needs both the flag and a non-production environment', () => {
    const on = { [DEV_PRINCIPAL_ENV_KEY]: '1' };

    expect(devPrincipalHeaderEnabled({ NODE_ENV: 'development' }, on)).toBe(true);
    expect(devPrincipalHeaderEnabled({ NODE_ENV: 'test' }, on)).toBe(true);
    expect(devPrincipalHeaderEnabled({ NODE_ENV: 'production' }, on)).toBe(false);
    expect(devPrincipalHeaderEnabled({ NODE_ENV: 'development' }, {})).toBe(false);
    expect(
      devPrincipalHeaderEnabled({ NODE_ENV: 'development' }, { [DEV_PRINCIPAL_ENV_KEY]: '0' }),
    ).toBe(false);
  });

  it('treats a value it cannot read as off', () => {
    expect(
      devPrincipalHeaderEnabled({ NODE_ENV: 'development' }, { [DEV_PRINCIPAL_ENV_KEY]: 'maybe' }),
    ).toBe(false);
  });
});

describe('createPrincipalResolver', () => {
  it('returns the dev resolver only when it is allowed, and says so loudly', () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');

    const resolver = createPrincipalResolver({
      env: { NODE_ENV: 'development' },
      logger,
      session: new DenyAllPrincipalResolver(),
      source: { [DEV_PRINCIPAL_ENV_KEY]: '1' },
    });

    expect(resolver).toBeInstanceOf(HeaderPrincipalResolver);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses the dev resolver in production and logs an error', () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');

    const session = new DenyAllPrincipalResolver();
    const resolver = createPrincipalResolver({
      env: { NODE_ENV: 'production' },
      logger,
      session,
      source: { [DEV_PRINCIPAL_ENV_KEY]: '1' },
    });

    // The session resolver, not the header one: the flag is refused rather
    // than obeyed, and the deploy still has a way to authenticate.
    expect(resolver).toBe(session);
    expect(error).toHaveBeenCalledOnce();
  });

  it('uses the session resolver when the flag is off, without complaining', () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');
    const session = new DenyAllPrincipalResolver();

    expect(
      createPrincipalResolver({ env: { NODE_ENV: 'development' }, logger, session, source: {} }),
    ).toBe(session);
    expect(error).not.toHaveBeenCalled();
  });
});
