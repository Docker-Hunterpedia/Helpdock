import { generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { RedisStub } from '../../testing/redis-stub.js';
import { previewPath, StaffAccess, type StaffPass } from './staff-access.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const STAFF = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';

const keys = async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { kid: 'k1', privateKey, publicKey };
};

const pass: StaffPass = {
  staffId: STAFF,
  familyId: 'family-1',
  name: 'Lina Haddad',
  brandId: BRAND,
  path: '/en',
};

const setup = async (families: Record<string, string> = { 'family-1': STAFF }) => {
  const signing = await keys();
  const access = new StaffAccess({
    redis: new RedisStub().asRedis(),
    keys: signing,
    families: { userOfFamily: (family) => Promise.resolve(families[family] ?? null) },
  });
  return { access, signing };
};

describe('StaffAccess passes', () => {
  it('spends a pass once', async () => {
    const { access } = await setup();
    const token = await access.issuePass(pass);

    expect(await access.spendPass(token)).toEqual(pass);
    expect(await access.spendPass(token)).toBeNull();
  });

  it('refuses a token that could not be one without asking Redis', async () => {
    const { access } = await setup();

    expect(await access.spendPass('')).toBeNull();
    expect(await access.spendPass('../../etc')).toBeNull();
  });
});

describe('StaffAccess cookies', () => {
  it('recognises its own cookie for the brand it was issued for, while the session lives', async () => {
    const { access } = await setup();
    const cookie = await access.cookieFor(pass);

    expect(await access.readerOf(cookie, BRAND)).toEqual({ staffId: STAFF, name: 'Lina Haddad' });
    expect(await access.readerOf(cookie, '0192c3f0-1a2b-7c3d-8e4f-0000000000b2')).toBeNull();
    expect(await access.readerOf(undefined, BRAND)).toBeNull();
    expect(await access.readerOf('not a jwt', BRAND)).toBeNull();
  });

  it('ends with the refresh family: a signed-out session no longer reads as staff', async () => {
    const families: Record<string, string> = { 'family-1': STAFF };
    const { access } = await setup(families);
    const cookie = await access.cookieFor(pass);
    delete families['family-1'];

    expect(await access.readerOf(cookie, BRAND)).toBeNull();
  });

  it('counts a family lookup that fails as signed out', async () => {
    const signing = await keys();
    const access = new StaffAccess({
      redis: new RedisStub().asRedis(),
      keys: signing,
      families: { userOfFamily: () => Promise.reject(new Error('redis down')) },
    });

    expect(await access.readerOf(await access.cookieFor(pass), BRAND)).toBeNull();
  });

  it('does not take an admin access token, or a token signed by another key, as the cookie', async () => {
    const { access, signing } = await setup();
    const accessToken = await new SignJWT({
      sid: 's',
      fam: 'family-1',
      brands: {},
      installAdmin: false,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject(STAFF)
      .setExpirationTime('10m')
      .sign(signing.privateKey);
    const stranger = new StaffAccess({
      redis: new RedisStub().asRedis(),
      keys: await keys(),
      families: { userOfFamily: () => Promise.resolve(STAFF) },
    });

    expect(await access.readerOf(accessToken, BRAND)).toBeNull();
    expect(await access.readerOf(await stranger.cookieFor(pass), BRAND)).toBeNull();
  });
});

describe('previewPath', () => {
  it('opens the article with the preview flag', () => {
    expect(previewPath('ar', 'refunds')).toBe('/ar/articles/refunds?preview=1');
  });
});
