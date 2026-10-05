import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local HTTP server standing in for api.telegram.org (M6). The Telegram
 * suites point `TELEGRAM_API_ROOT` at it: it answers the Bot API methods
 * Helpdock calls, records every call, serves files for `getFile`, and can be
 * told to refuse a chat the way Telegram refuses a user who blocked the bot.
 */

export interface TelegramCall {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

export interface FakeBot {
  readonly id: number;
  readonly username: string;
}

/** An uploaded file as the stand-in records it. */
export interface FakeUpload {
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * A JSON body, or grammY's multipart upload with each `attach://<part>`
 * reference replaced by the file it names.
 */
const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  const type = request.headers['content-type'] ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    const fields: Record<string, unknown> = {};
    for (const [key, value] of form) {
      if (typeof value !== 'string') {
        continue;
      }
      const part = value.startsWith('attach://') ? form.get(value.slice('attach://'.length)) : null;
      fields[key] =
        part instanceof File
          ? ({ name: part.name, bytes: Buffer.from(await part.arrayBuffer()) } satisfies FakeUpload)
          : value;
    }
    return fields;
  }
  const text = raw.toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
};

export class FakeTelegram {
  readonly calls: TelegramCall[] = [];
  /** Token → the bot `getMe` names. A token not here is a 401. */
  readonly bots = new Map<string, FakeBot>();
  /** file_id → bytes `getFile` serves. */
  readonly files = new Map<string, Buffer>();
  /** Updates the next `getUpdates` returns, per token. */
  readonly pending = new Map<string, unknown[]>();
  /** Chats `sendMessage` refuses with 403, as for a user who blocked the bot. */
  readonly blockedChats = new Set<string>();
  #server: Server | undefined;
  #messageId = 100;
  url = '';

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request).then(
        ({ status, body, raw }) => {
          response.statusCode = status;
          if (raw !== undefined) {
            response.end(raw);
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(body));
        },
        () => {
          response.statusCode = 500;
          response.end();
        },
      );
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server?.close(resolve));
  }

  /** The calls of one method, oldest first. */
  callsOf(method: string): TelegramCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async #handle(
    request: IncomingMessage,
  ): Promise<{ status: number; body?: unknown; raw?: Buffer }> {
    const url = request.url ?? '';
    const file = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(url);
    if (file !== null) {
      const bytes = this.files.get(decodeURIComponent(file[2] ?? ''));
      return bytes === undefined
        ? { status: 404, raw: Buffer.alloc(0) }
        : { status: 200, raw: bytes };
    }

    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url);
    const token = match?.[1] ?? '';
    const method = match?.[2] ?? '';
    const body = await readBody(request);
    this.calls.push({ token, method, body });

    const bot = this.bots.get(token);
    if (bot === undefined) {
      return refusal(401, 'Unauthorized');
    }

    switch (method) {
      case 'getMe':
        return ok({ id: bot.id, is_bot: true, first_name: bot.username, username: bot.username });
      case 'getWebhookInfo':
        return ok({
          url: String(
            [...this.callsOf('setWebhook')].reverse().find((call) => call.token === token)?.body
              .url ?? '',
          ),
          has_custom_certificate: false,
          pending_update_count: 0,
        });
      case 'getUpdates': {
        const updates = this.pending.get(token) ?? [];
        this.pending.set(token, []);
        return ok(updates);
      }
      case 'getFile':
        return ok({
          file_id: body.file_id,
          file_unique_id: `u-${String(body.file_id)}`,
          file_path: `files/${String(body.file_id)}`,
        });
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument':
        if (this.blockedChats.has(String(body.chat_id))) {
          return refusal(403, 'Forbidden: bot was blocked by the user');
        }
        this.#messageId += 1;
        return ok({
          message_id: this.#messageId,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: Number(body.chat_id), type: 'private' },
          ...(method === 'sendMessage' ? { text: body.text } : {}),
        });
      default:
        return ok(true);
    }
  }
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } });

const refusal = (code: number, description: string) => ({
  status: code,
  body: { ok: false, error_code: code, description },
});

/** A private text message from `chatId`, as Telegram posts it. */
export const textUpdate = (
  updateId: number,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1_000),
    chat: { id: chatId, type: 'private', first_name: 'Mona' },
    from: { id: chatId, is_bot: false, first_name: 'Mona', last_name: 'Khalil' },
    text,
    ...extra,
  },
});
