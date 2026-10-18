import { ssoConnectionCreateSchema, ssoConnectionSchema } from '@helpdock/schemas';
import { afterEach, expect, it, vi } from 'vitest';
import { SsoError } from './api.js';
import { HttpSsoApi } from './http-api.js';

const connection = ssoConnectionSchema.parse({
  ...ssoConnectionCreateSchema.parse({
    name: 'Work',
    config: {
      protocol: 'oidc',
      issuer: 'https://idp.example.com',
      clientId: 'helpdock',
    },
  }),
  id: '00000000-0000-4000-8000-000000000001',
  protocol: 'oidc',
  secretConfigured: true,
  lastSignInAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
});
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

it('strips internal secrets from received connection records and rejects malformed responses', async () => {
  let malformed = false;
  vi.stubGlobal('fetch', async () =>
    response(
      malformed
        ? { connections: [{ name: 'Incomplete' }] }
        : {
            connections: [{ ...connection, secretEncrypted: 'must-not-leak' }],
          },
    ),
  );
  const api = new HttpSsoApi();
  expect(await api.connections()).toEqual({ connections: [connection] });
  malformed = true;
  await expect(api.connections()).rejects.toThrow();
});

it.each([null, connection.id])(
  'sends the atomic configuration contract with no UI-only mapping keys (%s)',
  async (id) => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? '', body: JSON.parse(String(init.body)) });
      return response(connection);
    });
    const input = {
      connection: ssoConnectionCreateSchema.parse(connection),
      mappings: [
        {
          idpGroup: 'Support',
          brandId: connection.id,
          role: 'viewer' as const,
          departmentIds: null,
          position: 0,
          rowKey: 'local-draft-only',
        },
      ],
    };
    expect(await new HttpSsoApi().saveConfiguration(id, input)).toEqual(connection);
    expect(requests).toEqual([
      {
        url:
          id === null
            ? '/api/install/sso/configurations'
            : `/api/install/sso/connections/${id}/configuration`,
        method: id === null ? 'POST' : 'PUT',
        body: { ...input, mappings: input.mappings.map(({ rowKey: _key, ...mapping }) => mapping) },
      },
    ]);
  },
);

it('turns a refused save into the SSO rule and the domains it names', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'conflict',
            message: 'Another enabled connection already lists one of these email domains',
            requestId: 'req-1',
            sso: { reason: 'sso-email-domain-taken', domains: ['example.com'] },
          },
        }),
        { status: 409 },
      ),
  );
  const refused = new HttpSsoApi().update(
    connection.id,
    ssoConnectionCreateSchema.parse(connection),
  );
  await expect(refused).rejects.toBeInstanceOf(SsoError);
  await expect(refused).rejects.toMatchObject({
    reason: 'sso-email-domain-taken',
    domains: ['example.com'],
  });
});
