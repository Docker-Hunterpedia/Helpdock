import { uuidv7 } from '@helpdock/db';
import { generateKeyPair } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authRedis } from '../../testing/auth-redis.js';
import { silentLogger } from '../../testing/silent-logger.js';
import { issueAccessToken } from './access-token.js';
import { RefreshStore } from './refresh-store.js';
import { SessionPrincipalResolver } from './session-principal-resolver.js';
import type { SigningKeys } from './signing-keys.js';

const USER_ID = uuidv7();
const BRAND_ID = uuidv7();
const SESSION_ID = uuidv7();
const FAMILY_ID = uuidv7();

let keys: SigningKeys;
let refresh: RefreshStore;
let resolver: SessionPrincipalResolver;

beforeEach(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  keys = { kid: 'k1', privateKey, publicKey };
  refresh = new RefreshStore(authRedis().redis);
  resolver = new SessionPrincipalResolver({ keys, refresh, logger: silentLogger() });
});

const token = (overrides: Partial<Parameters<typeof issueAccessToken>[0]> = {}): Promise<string> =>
  issueAccessToken(
    {
      userId: USER_ID,
      sessionId: SESSION_ID,
      familyId: FAMILY_ID,
      brands: { [BRAND_ID]: { role: 'agent', departmentIds: [BRAND_ID] } },
      installAdmin: false,
      ...overrides,
    },
    keys,
  );

describe('SessionPrincipalResolver', () => {
  it('builds the staff principal straight out of the claims', async () => {
    const principal = await resolver.resolve({
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(principal).toEqual({
      type: 'staff',
      id: USER_ID,
      brands: { [BRAND_ID]: { role: 'agent', departmentIds: [BRAND_ID] } },
      installAdmin: false,
    });
  });

  it('carries installAdmin through, since only it may run all-brands paths', async () => {
    const principal = await resolver.resolve({
      headers: { authorization: `Bearer ${await token({ installAdmin: true })}` },
    });

    expect(principal).toMatchObject({ installAdmin: true });
  });

  it.each([
    ['no header at all', {}],
    ['an empty header', { authorization: '' }],
    ['another scheme', { authorization: 'Basic abc' }],
    ['a token that is not one', { authorization: 'Bearer nonsense' }],
  ])('answers null for %s', async (_case, headers) => {
    await expect(resolver.resolve({ headers })).resolves.toBeNull();
  });

  it('refuses a session that was revoked, inside the access token lifetime', async () => {
    const bearer = `Bearer ${await token()}`;
    await refresh.registerSession(FAMILY_ID, SESSION_ID);
    await expect(resolver.resolve({ headers: { authorization: bearer } })).resolves.not.toBeNull();

    await refresh.revokeFamily(FAMILY_ID);

    await expect(resolver.resolve({ headers: { authorization: bearer } })).resolves.toBeNull();
  });

  it('refuses the request when the revocation marker cannot be read', async () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');
    const failing = {
      isSessionRevoked: () => Promise.reject(new Error('redis is down')),
    } as unknown as RefreshStore;

    const refused = new SessionPrincipalResolver({ keys, refresh: failing, logger });

    await expect(
      refused.resolve({ headers: { authorization: `Bearer ${await token()}` } }),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalledOnce();
  });
});
