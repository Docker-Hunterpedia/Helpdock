import { FakeGraph } from '@helpdock/channels/testing';

/**
 * The Graph API stand-in the seeded api is pointed at with `META_GRAPH_API_ROOT`
 * and `META_INSTAGRAM_API_ROOT` (M10-07), so Channels › Meta can be driven end
 * to end without a Meta app: `packages/channels`' own `FakeGraph`, the one every
 * api suite uses, on a fixed port and with this suite's accounts connected.
 *
 * It was a second, smaller copy while the reason for it stood ("apps never
 * import each other", ARCHITECTURE §2); a package is not an app, and a copy
 * answers what its author remembered while the stand-in answers what Meta does
 * (the token's expiry, `debug_token`'s `app_id`, the business account a token
 * was granted on).
 *
 * A spec runs in another process than this one, so what it needs of the
 * stand-in goes over HTTP, to its `/__control/` routes: the subscription read
 * back ({@link subscriptionsUrl}), a token Meta revokes ({@link revokeToken})
 * and a refusal queued for the next matching call ({@link queueRefusal}).
 */

/** Not 3096 (Telegram's) or 3097 (`widget-restart`'s api replica). */
export const E2E_GRAPH_PORT = Number(process.env.HD_E2E_GRAPH_PORT ?? 3095);
export const E2E_GRAPH_URL = `http://127.0.0.1:${String(E2E_GRAPH_PORT)}`;
export const E2E_GRAPH_ROOT = `${E2E_GRAPH_URL}/facebook`;
export const E2E_INSTAGRAM_ROOT = `${E2E_GRAPH_URL}/instagram`;

/** The install's Meta app, which the api reads from `HD_META_APP_ID` and the stand-in names on every token. */
export const E2E_META_APP_ID = '1290457718832406';

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
/** A second token for the same Page: what an Admin pastes after Meta revoked the first. */
export const E2E_MESSENGER_RENEWED_TOKEN = 'EAAGe2ePageAccessToken0000000002';
/** Another Page, to show that a replacement token is held to the account it replaces. */
export const E2E_OTHER_MESSENGER: E2eAccount = {
  platform: 'messenger',
  id: '104857223900222',
  name: 'E2E Other Page',
  token: 'EAAGe2eOtherPageAccessToken000001',
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

const connect = (graph: FakeGraph, account: E2eAccount, token = account.token): void => {
  graph.connect({
    platform: account.platform,
    id: account.id,
    name: account.name,
    token,
    ...(account.username === undefined ? {} : { username: account.username }),
    ...(account.displayPhone === undefined ? {} : { displayPhone: account.displayPhone }),
    ...(account.wabaId === undefined ? {} : { wabaId: account.wabaId }),
  });
};

/**
 * Where a spec reads the app's subscription back from: by the node Meta keeps
 * it on, which is a WhatsApp number's business account and otherwise the account.
 */
export const subscriptionsUrl = (account: Pick<E2eAccount, 'id' | 'wabaId'>): string =>
  `${E2E_GRAPH_URL}/__control/subscriptions/${account.wabaId ?? account.id}`;

const control = async (route: string, body: unknown): Promise<void> => {
  const response = await fetch(`${E2E_GRAPH_URL}/__control/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`The Graph stand-in refused ${route}: ${String(response.status)}`);
  }
};

/** Meta revokes a token: every call with it answers 190 from now on. */
export const revokeToken = (token: string): Promise<void> => control('tokens/expire', { token });

/** Refuses the next call whose `METHOD /path` matches `match`, as Graph would answer it. */
export const queueRefusal = (refusal: {
  readonly status: number;
  readonly code: number;
  readonly message: string;
  readonly match: string;
}): Promise<void> =>
  control('failures', {
    status: refusal.status,
    body: { error: { code: refusal.code, message: refusal.message, type: 'OAuthException' } },
    match: refusal.match,
  });

export interface FakeGraphServer {
  stop(): Promise<void>;
}

export const startFakeGraph = async (): Promise<FakeGraphServer> => {
  const graph = new FakeGraph({ appId: E2E_META_APP_ID });
  for (const account of [E2E_WHATSAPP, E2E_MESSENGER, E2E_OTHER_MESSENGER, E2E_INSTAGRAM]) {
    connect(graph, account);
  }
  connect(graph, E2E_MESSENGER, E2E_MESSENGER_RENEWED_TOKEN);
  await graph.start(E2E_GRAPH_PORT);

  return { stop: () => graph.stop() };
};
