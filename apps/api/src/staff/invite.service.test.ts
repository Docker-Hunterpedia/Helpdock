import type { Db } from '@helpdock/db';
import { uuidv7 } from '@helpdock/db';
import type { InviteTokenPayload } from '@helpdock/schemas';
import { GoneException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/auth.service.js';
import { AuthFailure } from '../auth/auth-failure.js';
import { EmailTokenStore } from '../auth/email-token.store.js';
import type { OauthIdentity } from '../auth/oauth/oauth.service.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { authRedis } from '../testing/auth-redis.js';
import { silentLogger } from '../testing/silent-logger.js';
import { InviteService } from './invite.service.js';
import type { InviteStore } from './invite.store.js';
import type { StaffRepository } from './staff.repository.js';

/**
 * The provider half of accepting an invitation (M18-07), up to the point where
 * the invitation is spent. What happens after that — the account activated and
 * the provider account bound in one transaction — needs a database and is in
 * `auth/oauth/oauth-identity.integration.test.ts`.
 */

const INVITED = 'nour@helpdock.com';

const payload = (): InviteTokenPayload => ({
  purpose: 'invite',
  userId: uuidv7(),
  email: INVITED,
  brandId: uuidv7(),
  role: 'agent',
  departmentIds: [],
  issuedAt: Date.now(),
});

const github = (verifiedEmails: readonly string[]): OauthIdentity => ({
  provider: 'github',
  subject: '6060',
  email: verifiedEmails[0] ?? 'someone@example.com',
  name: 'Nour',
  authoritative: false,
  hostedDomain: undefined,
  verifiedEmails,
});

let tokens: EmailTokenStore;
let token: string;
let ssoEnforced: boolean;
let auth: {
  assertLocalSignInAllowed: ReturnType<typeof vi.fn>;
  startInviteOauth: ReturnType<typeof vi.fn>;
};
let service: InviteService;

beforeEach(async () => {
  tokens = new EmailTokenStore(authRedis().redis);
  token = await tokens.issue(payload(), 3_600);
  ssoEnforced = false;
  auth = {
    assertLocalSignInAllowed: vi.fn(() =>
      ssoEnforced ? Promise.reject(new AuthFailure('sso-required')) : Promise.resolve(),
    ),
    startInviteOauth: vi.fn(() =>
      Promise.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth', browserNonce: 'n' }),
    ),
  };
  service = new InviteService({
    // Neither path below reaches a transaction before it refuses or answers.
    db: {} as Db,
    staff: {} as StaffRepository,
    invites: {} as InviteStore,
    tokens,
    auth: auth as unknown as AuthService,
    limiter: { consume: () => Promise.resolve(true) } as unknown as RateLimiter,
    logger: silentLogger(),
  });
});

const stillLive = async (): Promise<boolean> => (await tokens.read(token, 'invite')) !== null;

describe('starting with a provider', () => {
  it('carries the token’s hash, never the token, and spends nothing', async () => {
    await service.startWithProvider(token, 'google', { name: 'Nour', locale: 'ar' }, '203.0.113.5');

    expect(auth.startInviteOauth).toHaveBeenCalledWith('google', {
      tokenHash: tokens.hashOf(token),
      name: 'Nour',
      locale: 'ar',
    });
    expect(JSON.stringify(auth.startInviteOauth.mock.calls)).not.toContain(token);
    expect(await stillLive()).toBe(true);
  });

  it('is refused under SSO enforcement, before any provider is asked', async () => {
    ssoEnforced = true;

    await expect(
      service.startWithProvider(token, 'google', { name: 'Nour', locale: 'en' }, '203.0.113.5'),
    ).rejects.toMatchObject({ auth: { code: 'sso-required' } });
    expect(auth.startInviteOauth).not.toHaveBeenCalled();
  });

  it('answers a link that is not a live invitation as gone', async () => {
    await expect(
      service.startWithProvider('not-a-token', 'google', { name: 'Nour', locale: 'en' }, '1.2.3.4'),
    ).rejects.toBeInstanceOf(GoneException);
  });
});

describe('the provider’s answer', () => {
  const answer = (identity: OauthIdentity) =>
    service.acceptWithProvider({
      invite: { tokenHash: tokens.hashOf(token), name: 'Nour', locale: 'en' },
      identity,
      userAgent: 'Firefox',
    });

  it('is the mismatch, and spends nothing, when no verified address is the invited one', async () => {
    await expect(answer(github(['nour@elsewhere.test']))).resolves.toEqual({
      kind: 'invite-mismatch',
      account: 'nour@elsewhere.test',
    });
    expect(await stillLive()).toBe(true);
  });

  it('is refused under SSO enforcement at the callback too, and spends nothing', async () => {
    ssoEnforced = true;

    await expect(answer(github([INVITED]))).rejects.toMatchObject({
      auth: { code: 'sso-required' },
    });
    expect(await stillLive()).toBe(true);
  });

  it('says the invitation expired when it was spent before the answer came', async () => {
    await tokens.consume(token, 'invite');

    await expect(answer(github([INVITED]))).rejects.toMatchObject({
      auth: { code: 'invite-expired' },
    });
  });
});
