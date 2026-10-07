import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * A stand-in for api.telegram.org that the seeded api is pointed at with
 * `TELEGRAM_API_ROOT` (M6-05), so Channels › Telegram can be driven end to end
 * without a real bot. It knows the bots below by token, refuses every other
 * token the way Telegram does, and remembers which webhook each bot was given.
 *
 * Its own copy rather than `apps/api`'s: apps never import each other
 * (ARCHITECTURE §2), and this one answers only what the screen asks for.
 */

/** Not 3097: `widget-restart` starts an api replica there (`HD_E2E_REPLICA_API_PORT`). */
export const E2E_TELEGRAM_PORT = Number(process.env.HD_E2E_TELEGRAM_PORT ?? 3096);
export const E2E_TELEGRAM_ROOT = `http://127.0.0.1:${String(E2E_TELEGRAM_PORT)}`;

/** A token the stand-in knows: `@e2e_support_bot`. */
export const E2E_BOT_TOKEN = '7400000001:AAEe2eSupportBotTokenAbcdefghijklmn';
export const E2E_BOT_USERNAME = 'e2e_support_bot';
/** One it refuses with Telegram's 401. */
export const E2E_REFUSED_TOKEN = '7400000002:AAErevokedTokenForTheBrowserSuiteAbc';

const BOTS = new Map([[E2E_BOT_TOKEN, { id: 7_400_000_001, username: E2E_BOT_USERNAME }]]);

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
};

export interface FakeTelegram {
  stop(): Promise<void>;
}

export const startFakeTelegram = async (): Promise<FakeTelegram> => {
  const webhooks = new Map<string, string>();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '');
      const token = match?.[1] ?? '';
      const method = match?.[2] ?? '';
      const body = await readJson(request);
      const bot = BOTS.get(token);
      const answer = (status: number, payload: unknown): void => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      };

      if (bot === undefined) {
        answer(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      switch (method) {
        case 'getMe':
          answer(200, {
            ok: true,
            result: { id: bot.id, is_bot: true, first_name: 'E2E Support', username: bot.username },
          });
          return;
        case 'setWebhook':
          webhooks.set(token, String(body.url ?? ''));
          answer(200, { ok: true, result: true });
          return;
        case 'deleteWebhook':
          webhooks.delete(token);
          answer(200, { ok: true, result: true });
          return;
        case 'getWebhookInfo':
          answer(200, {
            ok: true,
            result: {
              url: webhooks.get(token) ?? '',
              has_custom_certificate: false,
              pending_update_count: 0,
            },
          });
          return;
        default:
          answer(200, { ok: true, result: true });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(E2E_TELEGRAM_PORT, '127.0.0.1', resolve));

  return {
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
};
