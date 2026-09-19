import type { Principal } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { authenticateHandshake, handshakeToken, type SocketSession } from './handshake.js';
import { HandshakeRefusal } from './socket.js';

const USER = '01937f5e-7e53-7000-8000-000000000001';
const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

const staffPrincipal: Principal = { type: 'staff', id: USER, brands: {}, installAdmin: false };
const visitorPrincipal: Principal = {
  type: 'visitor',
  id: USER,
  brandId: BRAND,
  conversationIds: [],
};

const resolverFor = (session: SocketSession | null) => ({
  resolveSession: (token: string) => Promise.resolve(token === 'good' ? session : null),
});

const refusalOf = async (auth: unknown, session: SocketSession | null = null) => {
  try {
    await authenticateHandshake({ auth, resolver: resolverFor(session) });
    return expect.unreachable('the handshake should have been refused');
  } catch (error) {
    expect(error).toBeInstanceOf(HandshakeRefusal);
    return (error as HandshakeRefusal).data;
  }
};

describe('handshakeToken', () => {
  it.each([
    ['a bare token', { token: 'abc' }, 'abc'],
    [
      'a Bearer prefix, which a client that reuses its header will send',
      { token: 'Bearer abc' },
      'abc',
    ],
    ['a lowercase scheme', { token: 'bearer abc' }, 'abc'],
    ['surrounding whitespace', { token: '  abc  ' }, 'abc'],
  ])('reads %s', (_name, auth, expected) => {
    expect(handshakeToken(auth)).toBe(expected);
  });

  it.each([
    ['nothing at all', undefined],
    ['an empty token', { token: '' }],
    ['a token that is not a string', { token: 42 }],
    ['a bearer scheme with no token after it', { token: 'Bearer ' }],
    ['whitespace only', { token: '   ' }],
  ])('refuses %s', (_name, auth) => {
    expect(handshakeToken(auth)).toBeNull();
  });
});

describe('authenticateHandshake', () => {
  const session: SocketSession = {
    principal: staffPrincipal,
    sessionId: 'sid-1',
    familyId: 'fam-1',
    expiresAt: 1_800_000_000,
  };

  it('puts the principal, the session and the family on the socket', async () => {
    const data = await authenticateHandshake({
      auth: { token: 'good' },
      resolver: resolverFor(session),
    });

    expect(data).toMatchObject({
      principal: staffPrincipal,
      sessionId: 'sid-1',
      familyId: 'fam-1',
      expiresAt: 1_800_000_000,
    });
    expect(data.brandIds.size).toBe(0);
  });

  it('refuses a handshake with no token rather than letting it hang', async () => {
    expect(await refusalOf({})).toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a token the resolver does not recognise', async () => {
    expect(await refusalOf({ token: 'stale' }, session)).toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses a visitor: /staff is for staff, /widget is M4', async () => {
    expect(
      await refusalOf({ token: 'good' }, { ...session, principal: visitorPrincipal }),
    ).toMatchObject({ code: 'forbidden' });
  });
});
