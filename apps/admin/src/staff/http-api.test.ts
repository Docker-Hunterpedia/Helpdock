import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpAuthApi } from '../auth/http-api.js';
import { HttpTransport } from '../auth/http-transport.js';
import { isStaffError } from './api.js';
import { HttpStaffApi } from './http-api.js';

/**
 * The adapter against a stubbed `fetch`: what it sends, what it parses, and
 * what it makes of a refusal. That the endpoints behind it behave is the api's
 * integration suite.
 */

const BRAND_ID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const USER_ID = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';
const FAMILY_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';

const member = {
  userId: USER_ID,
  name: 'Omar Nasser',
  email: 'omar@helpdock.com',
  role: 'agent',
  departments: [],
  status: 'active',
  twoFactorEnabled: false,
  installAdmin: false,
  lastActiveAt: null,
  invitedAt: null,
  invitationExpiresAt: null,
  deactivatedAt: null,
  self: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const noContent = (): Response => new Response(null, { status: 204 });

const staffFailure = (reason: string, status = 409): Response =>
  json({ error: { code: 'conflict', message: 'no', requestId: 'r1', staff: { reason } } }, status);

let fetchMock: ReturnType<typeof vi.fn>;
let staff: HttpStaffApi;
let transport: HttpTransport;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  transport = new HttpTransport();
  staff = new HttpStaffApi(transport);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = (): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('fetch was not called');
  }

  return { url: String(call[0]), init: call[1] as RequestInit };
};

describe('reading', () => {
  it('asks for one brand and parses the list', async () => {
    fetchMock.mockResolvedValue(json({ staff: [member], viewerEnabled: true }));

    const list = await staff.listStaff(BRAND_ID);

    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/staff`);
    expect(list.staff[0]?.email).toBe('omar@helpdock.com');
  });

  it('puts a search in the query string, escaped', async () => {
    fetchMock.mockResolvedValue(json({ staff: [], viewerEnabled: true }));

    await staff.listStaff(BRAND_ID, 'a & b');

    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/staff?search=a%20%26%20b`);
  });

  it('leaves the query string off a blank search rather than sending an empty one', async () => {
    fetchMock.mockResolvedValue(json({ staff: [], viewerEnabled: true }));

    await staff.listStaff(BRAND_ID, '   ');

    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/staff`);
  });

  it('reads the departments of one brand', async () => {
    fetchMock.mockResolvedValue(json({ departments: [] }));

    await staff.departments(BRAND_ID);

    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/departments`);
  });
});

describe('the lifecycle calls', () => {
  it('posts an invitation', async () => {
    fetchMock.mockResolvedValue(json(member));

    await staff.invite(BRAND_ID, { email: 'new@example.com', role: 'agent', departmentIds: [] });

    const { url, init } = lastCall();
    expect(url).toBe(`/api/brands/${BRAND_ID}/staff/invites`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ email: 'new@example.com' });
  });

  it('resends and revokes an invitation on the invite routes', async () => {
    fetchMock.mockResolvedValue(noContent());

    await staff.resendInvite(BRAND_ID, USER_ID);
    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/staff/invites/${USER_ID}/resend`);

    await staff.revokeInvite(BRAND_ID, USER_ID);
    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND_ID}/staff/invites/${USER_ID}`,
      init: { method: 'DELETE' },
    });
  });

  it('patches a role', async () => {
    fetchMock.mockResolvedValue(json({ ...member, role: 'viewer' }));

    const updated = await staff.updateStaff(BRAND_ID, USER_ID, { role: 'viewer' });

    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND_ID}/staff/${USER_ID}`,
      init: { method: 'PATCH' },
    });
    expect(updated.role).toBe('viewer');
  });

  it('uses a different verb in the path for each direction of activation', async () => {
    // A `Response` body can only be read once, so each call gets its own.
    fetchMock.mockImplementation(() => Promise.resolve(json(member)));

    await staff.setActive(BRAND_ID, USER_ID, false);
    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/staff/${USER_ID}/deactivate`);

    await staff.setActive(BRAND_ID, USER_ID, true);
    expect(lastCall().url).toBe(`/api/brands/${BRAND_ID}/staff/${USER_ID}/reactivate`);
  });

  it('removes a role rather than an account', async () => {
    fetchMock.mockResolvedValue(noContent());

    await staff.removeFromBrand(BRAND_ID, USER_ID);

    expect(lastCall()).toMatchObject({
      url: `/api/brands/${BRAND_ID}/staff/${USER_ID}/role`,
      init: { method: 'DELETE' },
    });
  });
});

describe('a refusal', () => {
  it('arrives as a staff error carrying the rule that refused', async () => {
    fetchMock.mockResolvedValue(staffFailure('last-install-admin'));

    const error = await staff
      .setActive(BRAND_ID, USER_ID, false)
      .catch((raised: unknown) => raised);

    expect(isStaffError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'last-install-admin' });
  });

  it('is a staff error even when the status is a 403', async () => {
    fetchMock.mockResolvedValue(staffFailure('out-of-scope', 403));

    await expect(staff.removeFromBrand(BRAND_ID, USER_ID)).rejects.toMatchObject({
      reason: 'out-of-scope',
    });
  });
});

describe('the account the person owns', () => {
  it('reads and writes the profile on /me', async () => {
    const profile = {
      id: USER_ID,
      name: 'Omar',
      email: 'omar@helpdock.com',
      locale: 'en',
      twoFactorEnabled: false,
      recoveryCodesLeft: 0,
      twoFactorRequired: false,
    };
    fetchMock.mockImplementation(() => Promise.resolve(json(profile)));

    await staff.profile();
    expect(lastCall().url).toBe('/api/me/profile');

    await staff.updateProfile({ locale: 'ar' });
    expect(lastCall()).toMatchObject({ url: '/api/me/profile', init: { method: 'PATCH' } });
  });

  it('sends both passwords on a change', async () => {
    fetchMock.mockResolvedValue(noContent());

    await staff.changePassword('old one', 'a long enough password');

    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      currentPassword: 'old one',
      newPassword: 'a long enough password',
    });
  });

  it('sends a live code to weaken the second factor', async () => {
    fetchMock.mockResolvedValue(noContent());
    await staff.disableTotp('123456');
    expect(lastCall().url).toBe('/api/me/totp/disable');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ code: '123456' });

    fetchMock.mockResolvedValue(json({ recoveryCodes: ['RC-1'] }));
    const redrawn = await staff.regenerateRecoveryCodes('123456');
    expect(lastCall().url).toBe('/api/me/recovery-codes/regenerate');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ code: '123456' });
    expect(redrawn.recoveryCodes).toEqual(['RC-1']);
  });

  it('lists and ends one browser', async () => {
    fetchMock.mockResolvedValue(json({ sessions: [] }));
    await staff.sessions();
    expect(lastCall().url).toBe('/api/me/sessions');

    fetchMock.mockResolvedValue(noContent());
    await staff.revokeSession(FAMILY_ID);
    expect(lastCall()).toMatchObject({
      url: `/api/me/sessions/${FAMILY_ID}`,
      init: { method: 'DELETE' },
    });
  });
});

describe('sharing a transport with the auth adapter', () => {
  /**
   * One token in the app, not two. A staff request made after a sign-in has to
   * carry the token that sign-in obtained, or every screen would 401 once and
   * refresh its way back — which is the bug this pairing exists to prevent.
   */
  it('sends the token the auth adapter obtained', async () => {
    const auth = new HttpAuthApi(transport);
    fetchMock.mockResolvedValue(
      json({
        accessToken: 'the-token',
        expiresInSeconds: 600,
        session: {
          user: {
            id: USER_ID,
            name: 'Omar',
            email: 'omar@helpdock.com',
            role: 'admin',
            installAdmin: false,
          },
          brands: [
            { id: BRAND_ID, name: 'Helpdock', domain: 'support.example', ticketPrefix: 'HD' },
          ],
          currentBrandId: BRAND_ID,
        },
      }),
    );
    await auth.exchange('one-time-code');

    fetchMock.mockResolvedValue(json({ staff: [], viewerEnabled: true }));
    await staff.listStaff(BRAND_ID);

    expect((lastCall().init.headers as Record<string, string>).authorization).toBe(
      'Bearer the-token',
    );
  });
});

describe('the invite and enrolment calls on the auth adapter', () => {
  it('reads an invitation without spending it', async () => {
    const auth = new HttpAuthApi(transport);
    fetchMock.mockResolvedValue(
      json({
        email: 'karim@helpdock.com',
        inviterName: 'Lina',
        brandName: 'Helpdock',
        role: 'agent',
        departments: ['Support'],
        expiresAt: new Date().toISOString(),
      }),
    );

    await auth.previewInvite('a token/with slash');

    expect(lastCall()).toMatchObject({
      url: '/api/auth/invites/a%20token%2Fwith%20slash',
      init: { method: 'GET' },
    });
  });

  it('posts an acceptance and keeps the session it answers with', async () => {
    const auth = new HttpAuthApi(transport);
    fetchMock.mockResolvedValue(json({ kind: 'totp-enrolment-required', challengeId: 'c1' }));

    const result = await auth.acceptInvite('token', {
      name: 'Karim',
      password: 'a long enough password',
      locale: 'en',
    });

    expect(lastCall().url).toBe('/api/auth/invites/token/accept');
    expect(result).toEqual({ kind: 'totp-enrolment-required', challengeId: 'c1' });
  });

  it('stages and confirms a second factor', async () => {
    const auth = new HttpAuthApi(transport);

    fetchMock.mockResolvedValue(json({ secret: 'ABCD', uri: 'otpauth://totp/x' }));
    await expect(auth.enrolTotp()).resolves.toMatchObject({ secret: 'ABCD' });
    expect(lastCall().url).toBe('/api/auth/totp/enrol');

    fetchMock.mockResolvedValue(json({ recoveryCodes: ['RC-1'] }));
    await expect(auth.confirmTotp('123456')).resolves.toMatchObject({ recoveryCodes: ['RC-1'] });
    expect(lastCall().url).toBe('/api/auth/totp/confirm');
  });

  it('drops the token when signing out everywhere, whatever the server said', async () => {
    const auth = new HttpAuthApi(transport);
    transport.accessToken = 'the-token';
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(auth.signOutEverywhere()).rejects.toThrow();

    expect(transport.accessToken).toBeNull();
  });
});
