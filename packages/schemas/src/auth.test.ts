import { describe, expect, it } from 'vitest';
import {
  authErrorSchema,
  authMethodsSchema,
  emailTokenPayloadSchema,
  magicLinkTokenParamSchema,
  oauthCallbackQuerySchema,
  oauthProviderParamSchema,
  PASSWORD_MIN_LENGTH,
  passwordResetRequestSchema,
  sessionClaimsSchema,
  sessionSchema,
  signInResponseSchema,
  signInResultSchema,
  totpRequestSchema,
} from './auth.js';

const BRAND_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const USER_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';

const brand = {
  id: BRAND_ID,
  name: 'Helpdock',
  domain: 'support.helpdock.com',
  ticketPrefix: 'HD',
};

const session = {
  user: {
    id: USER_ID,
    name: 'Lina Haddad',
    email: 'lina@helpdock.com',
    role: 'admin',
    installAdmin: true,
  },
  brands: [brand],
  currentBrandId: BRAND_ID,
};

describe('sessionSchema', () => {
  it('accepts the shape the admin screens were built against', () => {
    expect(sessionSchema.parse(session)).toMatchObject({ currentBrandId: BRAND_ID });
  });

  it('refuses a session with no brand, because every screen is brand-scoped', () => {
    expect(sessionSchema.safeParse({ ...session, brands: [] }).success).toBe(false);
  });

  it('refuses a role outside the four in DOMAIN-RULES §1.1', () => {
    const owner = { ...session, user: { ...session.user, role: 'owner' } };

    expect(sessionSchema.safeParse(owner).success).toBe(false);
  });
});

describe('signInResultSchema', () => {
  it('tells a finished sign-in from one that still needs a code', () => {
    const challenge = signInResultSchema.parse({
      kind: 'totp-required',
      challengeId: 'c1',
      email: 'lina@helpdock.com',
    });

    expect(challenge.kind).toBe('totp-required');
    expect(signInResultSchema.safeParse({ kind: 'totp-required', challengeId: '' }).success).toBe(
      false,
    );
  });

  it('carries the enrolment an install that requires 2FA sends a new account to', () => {
    expect(
      signInResultSchema.parse({ kind: 'totp-enrolment-required', challengeId: 'c1' }).kind,
    ).toBe('totp-enrolment-required');
  });

  it('has no access token: the screens never hold one', () => {
    const parsed = signInResultSchema.parse({
      kind: 'session',
      session,
      accessToken: 'leaked.jwt.value',
    });

    expect(parsed).not.toHaveProperty('accessToken');
  });
});

describe('signInResponseSchema', () => {
  it('carries the token beside the session on the wire', () => {
    const parsed = signInResponseSchema.parse({
      kind: 'session',
      session,
      accessToken: 'a.b.c',
      expiresInSeconds: 600,
    });

    expect(parsed).toMatchObject({ accessToken: 'a.b.c', expiresInSeconds: 600 });
  });

  it('refuses a session answer with no token, which would sign nobody in', () => {
    expect(signInResponseSchema.safeParse({ kind: 'session', session }).success).toBe(false);
  });
});

describe('totpRequestSchema', () => {
  it.each([['12345'], ['1234567'], ['12a456'], ['']])('refuses %o as a code', (code) => {
    expect(
      totpRequestSchema.safeParse({ challengeId: 'c1', code, trustDevice: false }).success,
    ).toBe(false);
  });

  it('accepts six digits', () => {
    expect(
      totpRequestSchema.parse({ challengeId: 'c1', code: '482913', trustDevice: true }),
    ).toMatchObject({ code: '482913', trustDevice: true });
  });
});

describe('authErrorSchema', () => {
  it('carries the remaining attempts a mismatch counts down', () => {
    expect(authErrorSchema.parse({ code: 'totp-mismatch', attemptsLeft: 2 })).toEqual({
      code: 'totp-mismatch',
      attemptsLeft: 2,
    });
  });

  it('knows the OAuth failure an unknown address produces', () => {
    expect(authErrorSchema.parse({ code: 'no-account' }).code).toBe('no-account');
  });

  it('refuses a code the screens have no catalog key for', () => {
    expect(authErrorSchema.safeParse({ code: 'kaboom' }).success).toBe(false);
  });
});

describe('authMethodsSchema', () => {
  it('reports a provider with no client id as disabled rather than missing', () => {
    expect(
      authMethodsSchema.parse({
        password: true,
        magicLink: true,
        oauth: { google: true, github: false },
      }).oauth.github,
    ).toBe(false);
  });
});

describe('passwordResetRequestSchema', () => {
  it(`refuses a password shorter than ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(passwordResetRequestSchema.safeParse({ token: 't', password: 'short' }).success).toBe(
      false,
    );
  });

  it('accepts one at the floor', () => {
    const password = 'a'.repeat(PASSWORD_MIN_LENGTH);

    expect(passwordResetRequestSchema.parse({ token: 't', password }).password).toBe(password);
  });
});

describe('sessionClaimsSchema', () => {
  it('parses the claims the resolver builds a principal from', () => {
    const claims = sessionClaimsSchema.parse({
      sub: USER_ID,
      sid: BRAND_ID,
      fam: BRAND_ID,
      brands: { [BRAND_ID]: { role: 'team_leader', departmentIds: 'all' } },
      installAdmin: false,
      iat: 1,
      exp: 2,
    });

    expect(claims.brands[BRAND_ID]).toEqual({ role: 'team_leader', departmentIds: 'all' });
  });

  it('refuses the admin app spelling of a role, which is not what a claim carries', () => {
    const claims = {
      sub: USER_ID,
      sid: BRAND_ID,
      fam: BRAND_ID,
      brands: { [BRAND_ID]: { role: 'teamLeader', departmentIds: 'all' } },
      installAdmin: false,
      iat: 1,
      exp: 2,
    };

    expect(sessionClaimsSchema.safeParse(claims).success).toBe(false);
  });
});

describe('emailTokenPayloadSchema', () => {
  it('keeps the purpose on the record, so one token cannot be spent as another', () => {
    const magicLink = emailTokenPayloadSchema.parse({
      purpose: 'magic-link',
      userId: USER_ID,
      email: 'lina@helpdock.com',
      issuedAt: 1,
    });

    expect(magicLink.purpose).toBe('magic-link');
  });

  it('carries the role and departments an invite was created with (DOMAIN-RULES §12)', () => {
    const invite = emailTokenPayloadSchema.parse({
      purpose: 'invite',
      userId: USER_ID,
      email: 'sam@helpdock.com',
      brandId: BRAND_ID,
      role: 'agent',
      departmentIds: [BRAND_ID],
      issuedAt: 1,
    });

    expect(invite).toMatchObject({ role: 'agent', departmentIds: [BRAND_ID] });
  });
});

describe('the path and query schemas the auth routes name', () => {
  it('bounds a sign-in link token instead of judging it', () => {
    expect(magicLinkTokenParamSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(magicLinkTokenParamSchema.safeParse({ token: '' }).success).toBe(false);
    expect(magicLinkTokenParamSchema.safeParse({ token: 'x'.repeat(201) }).success).toBe(false);
  });

  it('bounds the provider segment, leaving which providers exist to the handler', () => {
    expect(oauthProviderParamSchema.safeParse({ provider: 'google' }).success).toBe(true);
    // Not a provider this install has. The handler answers `no-account` on a
    // screen, which a pipe could not do, so the schema must let it through.
    expect(oauthProviderParamSchema.safeParse({ provider: 'facebook' }).success).toBe(true);
    expect(oauthProviderParamSchema.safeParse({ provider: '' }).success).toBe(false);
  });

  it('accepts a callback with neither code nor state, which is how a refusal arrives', () => {
    expect(oauthCallbackQuerySchema.parse({})).toEqual({});
  });

  it('drops whatever else the provider appended', () => {
    expect(oauthCallbackQuerySchema.parse({ code: 'c', state: 's', scope: 'email' })).toEqual({
      code: 'c',
      state: 's',
    });
  });
});
