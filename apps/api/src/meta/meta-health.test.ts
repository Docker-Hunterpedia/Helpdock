import {
  classifyGraphError,
  GraphApiFailure,
  graphSubscribedApp,
  graphSubscribedApps,
  graphTokenExpired,
  META_FIXTURE,
} from '@helpdock/channels';
import type { MetaAccount } from '@helpdock/db';
import {
  META_ERROR_MAX_LENGTH,
  META_SUBSCRIBED_FIELDS,
  type MetaPlatform,
} from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { checkMetaAccount, type MetaHealthChecks } from './meta-health.js';
import type { TokenRefreshResult } from './meta-token-refresh.js';

/**
 * The decision table of `meta-health.ts` against a Graph double: what each
 * answer of each step does to the row. The same checks against the stand-in,
 * a database and the receipt are in `meta-health.integration.test.ts`.
 */

const TOKEN = 'EAAGhealthTOKEN1234567890abcdef';
const NOW = new Date('2026-10-11T09:20:00.000Z');
const APP_ID: string = META_FIXTURE.appId;

const account = (overrides: Partial<MetaAccount> = {}): MetaAccount => ({
  id: '01924f00-0000-7000-8000-0000000000ac',
  brandId: '01924f00-0000-7000-8000-0000000000aa',
  platform: 'messenger',
  departmentId: '01924f00-0000-7000-8000-0000000000dd',
  externalId: META_FIXTURE.pageId,
  wabaId: null,
  displayPhone: null,
  username: null,
  displayName: 'Acme Page',
  accessToken: 'v1.k1.ciphertext',
  tokenKind: 'page',
  tokenExpiresAt: null,
  tokenRefreshedAt: null,
  tokenUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
  tokenUpdatedBy: null,
  humanAgentEnabled: false,
  subscribedFields: [],
  subscribedAt: null,
  subscriptionCheckedAt: null,
  status: 'connected',
  lastEventAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

const instagram = (overrides: Partial<MetaAccount> = {}): MetaAccount =>
  account({
    platform: 'instagram',
    externalId: META_FIXTURE.igAccountId,
    tokenKind: 'instagram_user',
    ...overrides,
  });

const whatsapp = (overrides: Partial<MetaAccount> = {}): MetaAccount =>
  account({
    platform: 'whatsapp',
    externalId: META_FIXTURE.phoneNumberId,
    wabaId: META_FIXTURE.wabaId,
    tokenKind: 'system_user',
    ...overrides,
  });

interface Call {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly token: string;
  readonly api: string | undefined;
  readonly query: Readonly<Record<string, unknown>> | undefined;
}

/** A Graph that answers each call from `answer`: a body, or an error to throw. */
const graphDouble = (answer: (call: Call, calls: readonly Call[]) => unknown) => {
  const calls: Call[] = [];
  const run = async (
    method: Call['method'],
    path: string,
    request: { token: string; api?: string; query?: Record<string, unknown> },
  ): Promise<unknown> => {
    const call: Call = {
      method,
      path,
      token: request.token,
      api: request.api,
      query: request.query,
    };
    calls.push(call);
    const reply = answer(call, calls);
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };

  return {
    calls,
    graph: {
      get: (path: string, request: Parameters<typeof run>[2]) => run('GET', path, request),
      post: (path: string, request: Parameters<typeof run>[2]) => run('POST', path, request),
    } as MetaHealthChecks['graph'],
  };
};

const VALID = { data: { is_valid: true, expires_at: 0, type: 'PAGE' } };
const ME = { id: META_FIXTURE.igAccountId, username: 'acme', name: 'Acme' };
const refusal = (status: number, body: unknown): GraphApiFailure =>
  classifyGraphError(status, body, TOKEN);
const permissionDenied = {
  error: {
    code: 200,
    message: '(#200) Requires pages_messaging permission',
    type: 'OAuthException',
  },
};

type Platform = MetaPlatform;
/** `GET /{id}/subscribed_apps` listing one app per id. */
const subscribedApps = (platform: Platform, ...appIds: string[]) => ({
  data: appIds.map((appId) =>
    graphSubscribedApp(platform, { appId, fields: META_SUBSCRIBED_FIELDS[platform] }),
  ),
});
const subscribedTo = (platform: Platform, appId: string = APP_ID) =>
  subscribedApps(platform, appId);
const nobody = { data: [] };

const check = (
  graph: MetaHealthChecks['graph'],
  row: MetaAccount,
  {
    appId = APP_ID,
    refresh = vi.fn<MetaHealthChecks['refresh']>(async () => ({ outcome: 'not-due' })),
  }: { appId?: string; refresh?: MetaHealthChecks['refresh'] } = {},
) => checkMetaAccount({ graph, appId, refresh }, row, TOKEN, NOW);

describe('step 1, the token', () => {
  it('asks debug_token about the token itself for WhatsApp and Messenger', async () => {
    const { graph, calls } = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : subscribedTo('messenger'),
    );

    await check(graph, account());

    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/debug_token',
      token: TOKEN,
      api: undefined,
      query: { input_token: TOKEN },
    });
  });

  it('reads /me on the Instagram root instead, which has no debug_token', async () => {
    const { graph, calls } = graphDouble(({ path }) =>
      path === '/me' ? ME : subscribedTo('instagram'),
    );

    await check(graph, instagram());

    expect(calls[0]).toMatchObject({ method: 'GET', path: '/me', api: 'instagram', token: TOKEN });
    expect(calls.map((call) => call.path)).not.toContain('/debug_token');
  });

  it('marks token_expired when Graph refuses the token with 190, and goes no further', async () => {
    const { graph, calls } = graphDouble(() => refusal(400, graphTokenExpired()));

    const update = await check(graph, whatsapp());

    expect(update).toEqual({
      status: 'token_expired',
      lastError: expect.stringContaining('190/463: Error validating access token'),
      lastErrorAt: NOW,
    });
    expect(calls).toHaveLength(1);
  });

  it('marks token_expired when debug_token answers 200 with is_valid false', async () => {
    const { graph } = graphDouble(() => ({
      data: { is_valid: false, error: { code: 190, message: 'Session has expired' } },
    }));

    const update = await check(graph, account());

    expect(update).toEqual({
      status: 'token_expired',
      lastError: '190: Session has expired',
      lastErrorAt: NOW,
    });
  });

  it('marks an Instagram token Meta no longer knows, from /me, as token_expired', async () => {
    const { graph } = graphDouble(() =>
      refusal(401, { error: { code: 190, message: 'Invalid OAuth access token' } }),
    );

    const update = await check(graph, instagram());

    expect(update.status).toBe('token_expired');
  });

  it('records a refusal that is no verdict and leaves the status alone', async () => {
    const { graph, calls } = graphDouble(() => refusal(403, permissionDenied));

    const update = await check(graph, account({ status: 'connected' }));

    expect(update).toEqual({
      lastError:
        'Meta would not confirm the token: 200: (#200) Requires pages_messaging permission',
      lastErrorAt: NOW,
    });
    expect(update).not.toHaveProperty('status');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['Graph being down', 503, { error: { message: 'Service unavailable' } }],
    ['a rate limit', 429, { error: { code: 4, message: 'Application request limit reached' } }],
  ])(
    'throws for %s, so the job is asked again and nothing is recorded',
    async (_name, status, body) => {
      const { graph } = graphDouble(() => refusal(status, body));

      await expect(check(graph, account())).rejects.toBeInstanceOf(GraphApiFailure);
    },
  );
});

describe('step 2, the subscription', () => {
  it('leaves a subscribed app alone and records when it looked', async () => {
    const { graph, calls } = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : subscribedTo('messenger'),
    );

    const update = await check(graph, account());

    expect(update).toEqual({
      status: 'connected',
      subscriptionCheckedAt: NOW,
      subscribedFields: [...META_SUBSCRIBED_FIELDS.messenger],
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /debug_token',
      `GET /${META_FIXTURE.pageId}/subscribed_apps`,
    ]);
    expect(calls[1]?.api).toBe('graph');
  });

  it('keeps the stored fields for WhatsApp, whose subscription lists none', async () => {
    const { graph } = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : graphSubscribedApps('whatsapp'),
    );

    const update = await check(graph, whatsapp({ subscribedFields: ['messages'] }));

    expect(update).toEqual({ status: 'connected', subscriptionCheckedAt: NOW });
  });

  it('subscribes again when the app is missing, and reads it back', async () => {
    let subscribed = false;
    const { graph, calls } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      if (method === 'POST') {
        subscribed = true;
        return { success: true };
      }
      return subscribed ? subscribedTo('messenger') : nobody;
    });

    const update = await check(graph, account({ subscribedAt: null }));

    expect(update).toEqual({
      status: 'connected',
      subscriptionCheckedAt: NOW,
      subscribedFields: [...META_SUBSCRIBED_FIELDS.messenger],
      subscribedAt: NOW,
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'GET']);
    expect(calls[2]).toMatchObject({
      path: `/${META_FIXTURE.pageId}/subscribed_apps`,
      query: { subscribed_fields: META_SUBSCRIBED_FIELDS.messenger.join(',') },
    });
  });

  it('asks WhatsApp for no fields, since it subscribes the whole messages field', async () => {
    let subscribed = false;
    const { graph, calls } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      if (method === 'POST') {
        subscribed = true;
        return { success: true };
      }
      return subscribed ? graphSubscribedApps('whatsapp') : nobody;
    });

    await check(graph, whatsapp());

    expect(calls.find((call) => call.method === 'POST')?.query).toBeUndefined();
  });

  it('reads and subscribes WhatsApp on the business account, never on the number', async () => {
    let subscribed = false;
    const { graph, calls } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      if (method === 'POST') {
        subscribed = true;
        return { success: true };
      }
      return subscribed ? graphSubscribedApps('whatsapp') : nobody;
    });

    await check(graph, whatsapp());

    const subscriptionCalls = calls.filter((call) => call.path.endsWith('/subscribed_apps'));
    expect(subscriptionCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /${META_FIXTURE.wabaId}/subscribed_apps`,
      `POST /${META_FIXTURE.wabaId}/subscribed_apps`,
      `GET /${META_FIXTURE.wabaId}/subscribed_apps`,
    ]);
  });

  it('records that a number without a known business account cannot be checked, and asks Meta nothing', async () => {
    const { graph, calls } = graphDouble(() => VALID);

    const update = await check(graph, whatsapp({ wabaId: null, status: 'unsubscribed' }));

    expect(update).toEqual({
      lastError: 'The business account id is not known; reconnect the number',
      lastErrorAt: NOW,
    });
    expect(calls).toHaveLength(0);
  });

  it('subscribes Instagram on the Instagram root', async () => {
    let subscribed = false;
    const { graph, calls } = graphDouble(({ method, path }) => {
      if (path === '/me') {
        return ME;
      }
      if (method === 'POST') {
        subscribed = true;
        return { success: true };
      }
      return subscribed ? subscribedTo('instagram') : nobody;
    });

    await check(graph, instagram());

    expect(
      calls.filter((call) => call.path.endsWith('/subscribed_apps')).map((c) => c.api),
    ).toEqual(['instagram', 'instagram', 'instagram']);
  });

  it('counts only Helpdock’s own app: another app on the account does not stand in for it', async () => {
    let subscribed = false;
    const { graph, calls } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      if (method === 'POST') {
        subscribed = true;
        return { success: true };
      }
      return subscribed
        ? subscribedApps('messenger', '999', APP_ID)
        : subscribedTo('messenger', '999');
    });

    const update = await check(graph, account());

    expect(calls.some((call) => call.method === 'POST')).toBe(true);
    expect(update.subscribedAt).toEqual(NOW);
  });

  it('takes any subscribed app when the install has no app id set', async () => {
    const { graph, calls } = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : subscribedTo('messenger', '999'),
    );

    const update = await check(graph, account(), { appId: '' });

    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(update.status).toBe('connected');
  });

  it('marks unsubscribed when Graph refuses to subscribe the app again', async () => {
    const { graph } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      return method === 'POST' ? refusal(403, permissionDenied) : nobody;
    });

    const update = await check(graph, account());

    expect(update).toEqual({
      status: 'unsubscribed',
      lastError: expect.stringMatching(
        /^Meta dropped Helpdock's webhook subscription .* refused it again: 200: /,
      ),
      lastErrorAt: NOW,
    });
  });

  it('marks unsubscribed when the app is still not listed after subscribing again', async () => {
    const { graph } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      return method === 'POST' ? { success: true } : nobody;
    });

    const update = await check(graph, account());

    expect(update).toEqual({
      status: 'unsubscribed',
      lastError: expect.stringContaining('still does not list the app after subscribing again'),
      lastErrorAt: NOW,
    });
  });

  it('records a refused read of the subscription without guessing a status', async () => {
    const { graph } = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : refusal(403, permissionDenied),
    );

    const update = await check(graph, account({ status: 'unsubscribed' }));

    expect(update).toEqual({
      lastError:
        'Could not read the webhook subscription: 200: (#200) Requires pages_messaging permission',
      lastErrorAt: NOW,
    });
  });

  it('calls the token dead when it dies between the first step and the second', async () => {
    const { graph } = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : refusal(400, graphTokenExpired()),
    );

    expect((await check(graph, account())).status).toBe('token_expired');
  });

  it('throws when Graph fails while subscribing again', async () => {
    const { graph } = graphDouble(({ method, path }) => {
      if (path === '/debug_token') {
        return VALID;
      }
      return method === 'POST' ? refusal(502, {}) : nobody;
    });

    await expect(check(graph, account())).rejects.toBeInstanceOf(GraphApiFailure);
  });
});

describe('step 3, the Instagram renewal', () => {
  const wellSubscribed = ({ path }: Call) => (path === '/me' ? ME : subscribedTo('instagram'));

  it('asks for the renewal of an Instagram account, and of no other platform', async () => {
    const refresh = vi.fn<MetaHealthChecks['refresh']>(async () => ({ outcome: 'not-due' }));
    const messenger = graphDouble(({ path }) =>
      path === '/debug_token' ? VALID : subscribedTo('messenger'),
    );
    const ig = graphDouble(wellSubscribed);

    await check(messenger.graph, account(), { refresh });
    expect(refresh).not.toHaveBeenCalled();

    const row = instagram();
    await check(ig.graph, row, { refresh });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(row);
  });

  it('is connected after a renewal', async () => {
    const refresh = vi.fn<MetaHealthChecks['refresh']>(
      async (): Promise<TokenRefreshResult> => ({
        outcome: 'refreshed',
        expiresAt: new Date('2026-12-10T09:20:00.000Z'),
      }),
    );
    const { graph } = graphDouble(wellSubscribed);

    const update = await check(graph, instagram(), { refresh });

    expect(update.status).toBe('connected');
    expect(update.subscriptionCheckedAt).toEqual(NOW);
  });

  it('stays connected, and leaves the refusal the renewal wrote, when Meta refuses a token that still works', async () => {
    const refresh = vi.fn<MetaHealthChecks['refresh']>(async () => ({ outcome: 'refused' }));
    const { graph } = graphDouble(wellSubscribed);

    const update = await check(
      graph,
      instagram({
        status: 'unsubscribed',
        lastError: 'old',
        tokenExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
      }),
      { refresh },
    );

    expect(update).toMatchObject({ status: 'connected', subscriptionCheckedAt: NOW });
    // The renewal has just written `last_error`; this run must not clear it.
    expect(update).not.toHaveProperty('lastError');
  });

  it('is token_expired when Meta refuses and the row’s own expiry has passed', async () => {
    const refresh = vi.fn<MetaHealthChecks['refresh']>(async () => ({ outcome: 'refused' }));
    const { graph } = graphDouble(wellSubscribed);

    const update = await check(
      graph,
      instagram({ tokenExpiresAt: new Date('2026-10-10T00:00:00.000Z') }),
      { refresh },
    );

    expect(update.status).toBe('token_expired');
  });

  it('lets a failure of the renewal that is no answer end the run', async () => {
    const refresh = vi.fn<MetaHealthChecks['refresh']>(async () => {
      throw refusal(503, {});
    });
    const { graph } = graphDouble(wellSubscribed);

    await expect(check(graph, instagram(), { refresh })).rejects.toBeInstanceOf(GraphApiFailure);
  });
});

describe('step 4, all well', () => {
  const healthy = ({ path }: Call) => (path === '/debug_token' ? VALID : subscribedTo('messenger'));

  it.each([
    ['token_expired', 'The token expired'],
    ['unsubscribed', 'Meta dropped the subscription'],
  ] as const)(
    'clears the error the %s state was reporting, since it is over',
    async (status, error) => {
      const { graph } = graphDouble(healthy);

      const update = await check(
        graph,
        account({ status, lastError: error, lastErrorAt: new Date('2026-10-11T08:00:00.000Z') }),
      );

      expect(update).toMatchObject({ status: 'connected', lastError: null, lastErrorAt: null });
    },
  );

  it('keeps an error on a connected account, which may be the pipeline’s and not Meta’s', async () => {
    const { graph } = graphDouble(healthy);

    const update = await check(
      graph,
      account({ status: 'connected', lastError: 'filing failed', lastErrorAt: NOW }),
    );

    expect(update).not.toHaveProperty('lastError');
    expect(update).not.toHaveProperty('lastErrorAt');
  });
});

describe('what a problem says', () => {
  it('never carries the token, even when Graph quotes it', async () => {
    const { graph } = graphDouble(() =>
      refusal(400, {
        error: {
          code: 190,
          message: `Invalid OAuth access token ${TOKEN} for access_token=${TOKEN}`,
        },
      }),
    );

    const update = await check(graph, account());

    expect(JSON.stringify(update)).not.toContain(TOKEN);
    expect(update.lastError).toContain('<token>');
  });

  it('is cut to what last_error keeps', async () => {
    const { graph } = graphDouble(() =>
      refusal(400, { error: { code: 190, message: 'Session has expired. '.repeat(40) } }),
    );

    const update = await check(graph, account());

    expect(update.lastError?.length).toBeLessThanOrEqual(META_ERROR_MAX_LENGTH);
  });
});
