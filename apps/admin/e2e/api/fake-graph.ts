import { createServer, type Server } from 'node:http';

/**
 * A stand-in for the Graph API that the seeded api is pointed at with
 * `META_GRAPH_API_ROOT` and `META_INSTAGRAM_API_ROOT` (M10-07), so Channels ›
 * Meta can be driven end to end without a Meta app. One server answers both
 * roots, `/facebook` and `/instagram`, as the api's own suites' stand-in does.
 *
 * It answers only what the screens ask: who a token and an id are (Test and
 * Connect), whether the token is valid and what it was granted on
 * (`debug_token`), a business account's numbers (`/{waba}/phone_numbers`), and
 * the app's subscription to an account (`subscribed_apps`). A token it does not
 * know is refused with Meta's 190, a token is good on the root of its own
 * product only, and the subscriptions are remembered so a spec can read them back.
 *
 * As on Meta, a WhatsApp number is subscribed on its business account: the
 * number's own `subscribed_apps` is an unsupported edge, so a spec that passes
 * proves the api went to the business account.
 *
 * A spec runs in another process, so what the stand-in remembers is read back
 * over HTTP: `GET /__subscriptions/<node id>` answers the fields the app is
 * subscribed to on it (`[]` when it is not), the node being the business account
 * for a number and the account itself for a Page or an Instagram account.
 *
 * Its own copy rather than `packages/channels`' `FakeGraph`: apps never import
 * each other (ARCHITECTURE §2), and this one answers a handful of calls, not forty.
 */

/** Not 3096 (Telegram's) or 3097 (`widget-restart`'s api replica). */
export const E2E_GRAPH_PORT = Number(process.env.HD_E2E_GRAPH_PORT ?? 3095);
export const E2E_GRAPH_URL = `http://127.0.0.1:${String(E2E_GRAPH_PORT)}`;
export const E2E_GRAPH_ROOT = `${E2E_GRAPH_URL}/facebook`;
export const E2E_INSTAGRAM_ROOT = `${E2E_GRAPH_URL}/instagram`;

export interface E2eAccount {
  readonly platform: 'whatsapp' | 'messenger' | 'instagram';
  readonly id: string;
  readonly name: string;
  readonly username?: string;
  readonly displayPhone?: string;
  /** WhatsApp: the business account that owns the number and holds its subscription. */
  readonly wabaId?: string;
  readonly token: string;
}

/** A WhatsApp number, a Page and an Instagram account the stand-in knows, each with its token. */
/** The number as Meta displays it, which is what the list calls the account. */
export const E2E_WHATSAPP_PHONE = '+1 555 0199';
export const E2E_WHATSAPP: E2eAccount = {
  platform: 'whatsapp',
  id: '109384715588204',
  name: 'E2E Support',
  displayPhone: E2E_WHATSAPP_PHONE,
  wabaId: '103402219873345',
  token: 'EAAGe2eWhatsappSystemUserToken001',
};
export const E2E_MESSENGER: E2eAccount = {
  platform: 'messenger',
  id: '104857223900111',
  name: 'E2E Page',
  token: 'EAAGe2ePageAccessToken0000000001',
};
export const E2E_INSTAGRAM: E2eAccount = {
  platform: 'instagram',
  id: '17841405822300111',
  name: 'E2E Gram',
  username: 'e2e_gram',
  token: 'IGAAe2eInstagramUserToken00000001',
};
/** A token no account has, refused as Meta refuses one it never issued. */
export const E2E_REFUSED_META_TOKEN = 'EAAGe2eRevokedTokenForTheBrowserSuite';
/** What the stand-in says to it, which the screen quotes. */
export const E2E_REFUSED_META_DETAIL = 'Invalid OAuth access token - Cannot parse access token';

/**
 * A system-user token that reads the number but was never assigned its business
 * account, so `debug_token` names none: Meta would let the number be read and
 * refuse to subscribe the app to it.
 */
export const E2E_UNASSIGNED_WHATSAPP_TOKEN = 'EAAGe2eUnassignedSystemUserToken01';
const UNASSIGNED_WHATSAPP: E2eAccount = {
  platform: 'whatsapp',
  id: E2E_WHATSAPP.id,
  name: E2E_WHATSAPP.name,
  displayPhone: E2E_WHATSAPP_PHONE,
  token: E2E_UNASSIGNED_WHATSAPP_TOKEN,
};

const ACCOUNTS: readonly E2eAccount[] = [
  E2E_WHATSAPP,
  UNASSIGNED_WHATSAPP,
  E2E_MESSENGER,
  E2E_INSTAGRAM,
];

const rootOf = (platform: E2eAccount['platform']): 'facebook' | 'instagram' =>
  platform === 'instagram' ? 'instagram' : 'facebook';

const failure = (status: number, code: number, message: string) => ({
  status,
  body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'E2E' } },
});

/**
 * Where a spec reads the app's subscription back from: by the node Meta keeps it
 * on, which is a WhatsApp number's business account and otherwise the account.
 */
export const subscriptionsUrl = (account: Pick<E2eAccount, 'id' | 'wabaId'>): string =>
  `${E2E_GRAPH_URL}/__subscriptions/${account.wabaId ?? account.id}`;

export interface FakeGraphServer {
  stop(): Promise<void>;
}

export const startFakeGraph = async (): Promise<FakeGraphServer> => {
  const subscriptions = new Map<string, string[]>();

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', E2E_GRAPH_URL);
    const answer = (status: number, body: unknown): void => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };

    const remembered = /^\/__subscriptions\/(\d+)$/.exec(url.pathname);
    if (remembered !== null) {
      answer(200, { fields: subscriptions.get(remembered[1] ?? '') ?? [] });
      return;
    }

    const route = /^\/(facebook|instagram)\/v\d+\.\d+\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    const [, root, first, second] = route ?? [];
    const bearer = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const token = bearer ?? url.searchParams.get('access_token') ?? '';
    const own = ACCOUNTS.find((account) => account.token === token);

    if (route === null || first === undefined) {
      const refused = failure(400, 100, 'Unknown path components');
      answer(refused.status, refused.body);
      return;
    }
    if (own === undefined || rootOf(own.platform) !== root) {
      const refused = failure(401, 190, E2E_REFUSED_META_DETAIL);
      answer(refused.status, refused.body);
      return;
    }

    if (second === undefined && first === 'debug_token') {
      answer(200, {
        data: {
          is_valid: true,
          expires_at: 0,
          type: own.platform === 'whatsapp' ? 'SYSTEM_USER' : 'PAGE',
          granular_scopes:
            own.wabaId === undefined
              ? []
              : [
                  { scope: 'whatsapp_business_management', target_ids: [own.wabaId] },
                  { scope: 'whatsapp_business_messaging', target_ids: [own.wabaId] },
                ],
        },
      });
      return;
    }
    if (second === undefined) {
      // `GET /me`, or `GET /{id}` for an id the token opens.
      const id = first === 'me' ? own.id : first;
      if (id !== own.id) {
        const refused = failure(400, 100, 'Object does not exist or missing permissions');
        answer(refused.status, refused.body);
        return;
      }
      answer(200, {
        id: own.id,
        ...(own.platform === 'whatsapp'
          ? { verified_name: own.name, display_phone_number: own.displayPhone }
          : { name: own.name }),
        ...(own.username === undefined ? {} : { username: own.username }),
      });
      return;
    }
    if (second === 'phone_numbers' && first === own.wabaId && request.method === 'GET') {
      answer(200, { data: [{ id: own.id, display_phone_number: own.displayPhone }], paging: {} });
      return;
    }
    if (second === 'subscribed_apps' && first === (own.wabaId ?? own.id)) {
      if (request.method === 'POST') {
        // WhatsApp subscribes the whole `messages` field and takes none by name.
        const named = url.searchParams.get('subscribed_fields');
        subscriptions.set(first, named === null ? ['messages'] : named.split(','));
        answer(200, { success: true });
      } else if (request.method === 'DELETE') {
        subscriptions.delete(first);
        answer(200, { success: true });
      } else {
        const fields = subscriptions.get(first);
        const app = { id: '1290457718832406', name: 'Helpdock' };
        answer(200, {
          data:
            fields === undefined
              ? []
              : [
                  own.platform === 'whatsapp'
                    ? { whatsapp_business_api_data: app }
                    : { ...app, subscribed_fields: fields },
                ],
        });
      }
      return;
    }

    const refused = failure(400, 100, 'Unknown path components');
    answer(refused.status, refused.body);
  });

  await new Promise<void>((resolve) => server.listen(E2E_GRAPH_PORT, '127.0.0.1', resolve));

  return {
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
};
