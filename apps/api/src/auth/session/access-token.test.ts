import { uuidv7 } from '@helpdock/db';
import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  bearerTokenOf,
  issueAccessToken,
  verifyAccessToken,
} from './access-token.js';
import type { SigningKeys } from './signing-keys.js';

const keysFor = async (algorithm = 'ES256'): Promise<SigningKeys> => {
  const { privateKey, publicKey } = await generateKeyPair(algorithm, { extractable: true });
  return { kid: 'k1', privateKey, publicKey };
};

const USER_ID = uuidv7();
const BRAND_ID = uuidv7();

const input = {
  userId: USER_ID,
  sessionId: uuidv7(),
  familyId: uuidv7(),
  brands: { [BRAND_ID]: { role: 'admin', departmentIds: 'all' } },
  installAdmin: true,
} as const;

describe('issueAccessToken', () => {
  it('carries the claims ARCHITECTURE §7 lists, and nothing else', async () => {
    const keys = await keysFor();

    const claims = await verifyAccessToken(await issueAccessToken(input, keys), keys);

    expect(Object.keys(claims ?? {}).sort()).toEqual([
      'brands',
      'exp',
      'fam',
      'iat',
      'installAdmin',
      'sid',
      'sub',
    ]);
    expect(claims).toMatchObject({
      sub: USER_ID,
      sid: input.sessionId,
      fam: input.familyId,
      installAdmin: true,
      brands: { [BRAND_ID]: { role: 'admin', departmentIds: 'all' } },
    });
  });

  it('expires ten minutes out, which is the window DOMAIN-RULES §1.6 allows', async () => {
    const keys = await keysFor();

    const claims = await verifyAccessToken(await issueAccessToken(input, keys), keys);

    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('names the key in the header, so a rotation can say which key signed what', async () => {
    const keys = await keysFor();
    const [header] = (await issueAccessToken(input, keys)).split('.');

    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toMatchObject({
      alg: 'ES256',
      kid: 'k1',
    });
  });
});

describe('verifyAccessToken', () => {
  it('refuses a token signed with another install key pair', async () => {
    const mine = await keysFor();
    const theirs = await keysFor();

    await expect(
      verifyAccessToken(await issueAccessToken(input, theirs), mine),
    ).resolves.toBeNull();
  });

  it('refuses an expired token', async () => {
    const keys = await keysFor();
    const expired = await new SignJWT({ ...input, sid: input.sessionId })
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
      .setSubject(USER_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3_600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);

    await expect(verifyAccessToken(expired, keys)).resolves.toBeNull();
  });

  it('refuses a token whose header asks for another algorithm', async () => {
    const keys = await keysFor();
    const other = await keysFor('PS256');
    const wrongAlg = await new SignJWT({ sid: input.sessionId })
      .setProtectedHeader({ alg: 'PS256', kid: keys.kid })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(other.privateKey);

    await expect(
      verifyAccessToken(wrongAlg, { ...keys, publicKey: other.publicKey }),
    ).resolves.toBeNull();
  });

  it('refuses an unsigned token, whatever its claims say', async () => {
    const keys = await keysFor();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: USER_ID, sid: input.sessionId, installAdmin: true }),
    ).toString('base64url');

    await expect(verifyAccessToken(`${header}.${payload}.`, keys)).resolves.toBeNull();
  });

  it('refuses a correctly signed token whose claims are not a session', async () => {
    const keys = await keysFor();
    const odd = await new SignJWT({ hello: 'world' })
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(keys.privateKey);

    await expect(verifyAccessToken(odd, keys)).resolves.toBeNull();
  });

  it.each(['', 'nonsense', 'a.b', 'a.b.c'])('refuses %o', async (token) => {
    await expect(verifyAccessToken(token, await keysFor())).resolves.toBeNull();
  });
});

describe('bearerTokenOf', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
  ])('reads %o', (header, expected) => {
    expect(bearerTokenOf(header)).toBe(expected);
  });

  it.each([undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer a b', ['Bearer a']])(
    'refuses %o',
    (header) => {
      expect(bearerTokenOf(header as string | string[] | undefined)).toBeNull();
    },
  );
});
