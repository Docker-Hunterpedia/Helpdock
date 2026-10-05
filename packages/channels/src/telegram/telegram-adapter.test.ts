import { describe, expect, it } from 'vitest';
import { ChannelCapabilityError } from '../adapter.js';
import {
  TelegramChannelAdapter,
  type TelegramMessageEvent,
  telegramExternalId,
  toTelegramInboundMessage,
} from './telegram-adapter.js';

const event = (fields: Partial<TelegramMessageEvent> = {}): TelegramMessageEvent => ({
  kind: 'message',
  updateId: 1,
  messageId: 11,
  sender: { chatId: '4242', name: 'Mona', username: 'mona_k', languageCode: null },
  text: 'Hello <b>there</b>',
  files: [],
  location: null,
  sentAt: new Date(0),
  ...fields,
});

const receivedAt = new Date('2026-10-05T10:00:00Z');

describe('toTelegramInboundMessage', () => {
  it('is a message from the chat, keyed by bot, chat and message', () => {
    const message = toTelegramInboundMessage(
      { event: event(), botTelegramId: 99, files: [], locationLabel: 'Location' },
      receivedAt,
    );

    expect(message).toMatchObject({
      channel: 'telegram',
      externalId: '99:4242:11',
      from: { kind: 'telegram', value: '4242', name: 'Mona' },
      cc: [],
      hints: { messageIds: [], ticketNumbers: [] },
      receivedAt,
      telegram: { chatId: '4242', messageId: 11, location: null, username: 'mona_k' },
    });
  });

  it('escapes what the customer typed rather than reading it as markup', () => {
    const message = toTelegramInboundMessage(
      { event: event(), botTelegramId: 99, files: [], locationLabel: 'Location' },
      receivedAt,
    );

    expect(message.bodyHtml).not.toContain('<b>');
    expect(message.bodyText).toBe('Hello <b>there</b>');
  });

  it('adds a location as text with its map link', () => {
    const message = toTelegramInboundMessage(
      {
        event: event({
          text: '',
          location: { latitude: 1.5, longitude: 2.5, title: null, address: null },
        }),
        botTelegramId: 99,
        files: [],
        locationLabel: 'Location',
      },
      receivedAt,
    );

    expect(message.bodyText).toContain('Location: 1.5, 2.5');
    expect(message.bodyHtml).toContain('href="https://www.openstreetmap.org/?mlat=1.5');
  });
});

it('keys a message by bot, chat and message id', () => {
  expect(telegramExternalId(1, '-5', 3)).toBe('1:-5:3');
});

describe('TelegramChannelAdapter', () => {
  const adapter = new TelegramChannelAdapter({ now: () => receivedAt });

  it('normalises through the same function', async () => {
    await adapter.init();
    const message = await adapter.handleInbound({
      event: event(),
      botTelegramId: 99,
      files: [],
      locationLabel: 'Location',
    });
    expect(message.receivedAt).toBe(receivedAt);
    expect(await adapter.health()).toEqual({ state: 'healthy', detail: null });
  });

  it('leaves sending to the outbox', async () => {
    await expect(adapter.send()).rejects.toBeInstanceOf(ChannelCapabilityError);
  });
});
