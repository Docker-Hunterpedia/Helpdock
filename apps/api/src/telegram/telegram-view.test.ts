import type { TelegramBot as TelegramBotRow, TelegramDelivery } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { toTelegramBot, toTelegramDelivery, webhookUrlFor } from './telegram-view.js';

const at = new Date('2026-10-05T10:00:00Z');
const botId = '01924f00-0000-7000-8000-0000000000dd';

const row = (fields: Partial<TelegramBotRow> = {}): TelegramBotRow => ({
  id: botId,
  brandId: 'brand',
  telegramId: 7,
  username: 'acme_bot',
  displayName: 'Acme',
  departmentId: 'dept',
  token: 'v1.sealed',
  tokenUpdatedAt: at,
  tokenUpdatedBy: null,
  webhookSecret: 'v1.sealed-secret',
  welcomeEn: null,
  welcomeAr: 'أهلا',
  languagePick: true,
  webhookUrl: null,
  webhookSetAt: null,
  pollOffset: null,
  lastUpdateAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: at,
  updatedAt: at,
  ...fields,
});

describe('toTelegramBot', () => {
  it('says a token is set without ever carrying it or the webhook secret', () => {
    const view = toTelegramBot(
      { bot: row(), departmentName: 'Support', tokenUpdatedByName: 'Ada' },
      { appUrl: 'https://support.example.com', polling: false },
    );

    expect(view).toMatchObject({
      tokenSet: true,
      welcome: { en: null, ar: 'أهلا' },
      mode: 'webhook',
      health: { state: 'waiting' },
      webhook: { expectedUrl: `https://support.example.com/api/telegram/${botId}/webhook` },
    });
    expect(JSON.stringify(view)).not.toContain('sealed');
  });

  it('reports polling mode and a failing bot', () => {
    const view = toTelegramBot(
      {
        bot: row({ lastError: '401: Unauthorized', lastErrorAt: at }),
        departmentName: 'Support',
        tokenUpdatedByName: null,
      },
      { appUrl: 'https://support.example.com', polling: true },
    );
    expect(view.mode).toBe('polling');
    expect(view.health).toEqual({
      state: 'failing',
      lastUpdateAt: null,
      lastError: '401: Unauthorized',
      lastErrorAt: at.toISOString(),
    });
  });
});

it('builds the webhook URL under a base path', () => {
  expect(webhookUrlFor('https://example.com/desk/', botId)).toBe(
    `https://example.com/api/telegram/${botId}/webhook`,
  );
});

it('shows a delivery with the attempts it is allowed', () => {
  const delivery = {
    id: 'd',
    ticketMessageId: 'm',
    status: 'failed',
    attempts: 5,
    lastError: '403: Forbidden',
    sentAt: null,
    failedAt: at,
  } as TelegramDelivery;

  expect(toTelegramDelivery(delivery)).toEqual({
    id: 'd',
    messageId: 'm',
    status: 'failed',
    attempts: 5,
    maxAttempts: 5,
    lastError: '403: Forbidden',
    sentAt: null,
    failedAt: at.toISOString(),
  });
});
