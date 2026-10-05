import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GrammyError, HttpError } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelegramApiFailure, TelegramBotApi, toTelegramFailure } from './bot-api.js';

/** A local HTTP server standing in for api.telegram.org. */

const TOKEN = '123456:secret-part-of-the-token-abcdefghijklmnop';

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
};

describe('TelegramBotApi', () => {
  const calls: Call[] = [];
  let server: Server;
  let apiRoot = '';
  let file = Buffer.from('OggS voice bytes');

  const api = () => new TelegramBotApi({ token: TOKEN, apiRoot: `${apiRoot}/` });

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const url = request.url ?? '';
        if (url === `/file/bot${TOKEN}/voice/file_1.oga`) {
          response.end(file);
          return;
        }
        const method = url.slice(`/bot${TOKEN}/`.length);
        const body = await readBody(request);
        calls.push({ method, body });
        const reply = (result: unknown) => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: true, result }));
        };
        switch (method) {
          case 'getMe':
            reply({ id: 123456, is_bot: true, first_name: 'Acme', username: 'acme_bot' });
            return;
          case 'getWebhookInfo':
            reply({
              url: 'https://support.example.com/hook',
              has_custom_certificate: false,
              pending_update_count: 2,
              last_error_date: 1_790_000_000,
              last_error_message: 'Connection refused',
            });
            return;
          case 'sendMessage':
            if (body.chat_id === '0') {
              response.statusCode = 400;
              response.setHeader('content-type', 'application/json');
              response.end(
                JSON.stringify({
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: chat not found',
                }),
              );
              return;
            }
            reply({ message_id: 77, date: 0, chat: { id: 1, type: 'private' } });
            return;
          case 'getFile':
            reply(
              body.file_id === 'missing'
                ? { file_id: 'missing', file_unique_id: 'm' }
                : { file_id: 'f', file_unique_id: 'u', file_path: 'voice/file_1.oga' },
            );
            return;
          case 'getUpdates':
            reply([{ update_id: 5 }]);
            return;
          default:
            reply(true);
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiRoot = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads who the bot is', async () => {
    expect(await api().getMe()).toEqual({ id: 123456, username: 'acme_bot' });
  });

  it('registers the webhook with its secret and only the updates Helpdock reads', async () => {
    await api().setWebhook('https://support.example.com/api/telegram/x/webhook', 'shh');
    expect(calls.at(-1)).toEqual({
      method: 'setWebhook',
      body: {
        url: 'https://support.example.com/api/telegram/x/webhook',
        secret_token: 'shh',
        allowed_updates: ['message', 'callback_query'],
      },
    });
  });

  it('reads the webhook’s state', async () => {
    expect(await api().getWebhookInfo()).toEqual({
      url: 'https://support.example.com/hook',
      pendingUpdateCount: 2,
      lastErrorAt: new Date(1_790_000_000_000),
      lastErrorMessage: 'Connection refused',
    });
  });

  it('sends a message, with a keyboard when asked, and answers a button', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'English', callback_data: 'lang:en' }]] };
    expect(await api().sendMessage('42', 'Hello', keyboard)).toBe('77');
    expect(calls.at(-1)).toEqual({
      method: 'sendMessage',
      body: { chat_id: '42', text: 'Hello', reply_markup: keyboard },
    });
    await api().answerCallbackQuery('cq-1');
    expect(calls.at(-1)).toEqual({
      method: 'answerCallbackQuery',
      body: { callback_query_id: 'cq-1' },
    });
  });

  it('polls from an offset without waiting', async () => {
    expect(await api().getUpdates(5)).toEqual([{ update_id: 5 }]);
    expect(calls.at(-1)?.body).toMatchObject({ offset: 5, timeout: 0 });
    await api().getUpdates(null);
    expect(calls.at(-1)?.body).not.toHaveProperty('offset');
  });

  it('downloads a file through getFile', async () => {
    file = Buffer.from('OggS voice bytes');
    expect((await api().downloadFile('f')).toString()).toBe('OggS voice bytes');
  });

  it('refuses a file over the cap, and one Telegram gives no path for', async () => {
    file = Buffer.alloc(64, 1);
    await expect(api().downloadFile('f', 10)).rejects.toMatchObject({ kind: 'refused' });
    await expect(api().downloadFile('missing')).rejects.toBeInstanceOf(TelegramApiFailure);
  });

  it('turns a refusal into Telegram’s words', async () => {
    await expect(api().sendMessage('0', 'Hello')).rejects.toMatchObject({
      kind: 'refused',
      detail: '400: Bad Request: chat not found',
      permanent: true,
    });
  });

  it('reads a server that is not there as unreachable', async () => {
    await expect(
      new TelegramBotApi({ token: TOKEN, apiRoot: 'http://127.0.0.1:1' }).getMe(),
    ).rejects.toMatchObject({ kind: 'connect' });
  });
});

describe('toTelegramFailure', () => {
  it('reads a refused token as a token problem', () => {
    const error = new GrammyError(
      "Call to 'getMe' failed!",
      { ok: false, error_code: 401, description: 'Unauthorized' },
      'getMe',
      {},
    );
    expect(toTelegramFailure(error)).toMatchObject({ kind: 'token', detail: '401: Unauthorized' });
  });

  it('reads a rate limit as worth retrying', () => {
    const error = new GrammyError(
      "Call to 'sendMessage' failed!",
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 3',
        parameters: { retry_after: 3 },
      },
      'sendMessage',
      {},
    );
    expect(toTelegramFailure(error)).toMatchObject({ kind: 'refused', permanent: false });
  });

  it('never repeats the token from a transport error', () => {
    const failure = toTelegramFailure(
      new HttpError(`fetch to /bot${TOKEN}/getMe failed`, null),
      TOKEN,
    );
    expect(failure.kind).toBe('connect');
    expect(failure.detail).not.toContain(TOKEN);
  });

  it('passes a failure through unchanged and reads anything else as unreachable', () => {
    const failure = new TelegramApiFailure('refused', 'no');
    expect(toTelegramFailure(failure)).toBe(failure);
    expect(toTelegramFailure('boom')).toMatchObject({ kind: 'connect', detail: 'boom' });
  });
});
