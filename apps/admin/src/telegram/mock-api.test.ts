import { describe, expect, it } from 'vitest';
import { MOCK_TICKET_ARABIC, MOCK_TICKET_REFUND } from '../tickets/mock-api.js';
import {
  MOCK_BILLING_BOT,
  MOCK_GOOD_TOKEN,
  MOCK_REFUSED_TOKEN,
  MOCK_SUPPORT_BOT,
  MockTelegramApi,
} from './mock-api.js';

/**
 * The fixture refuses what the api refuses, closely enough for the screens'
 * error lines to be exercised; the real rules are the api's and are tested in
 * `telegram.integration.test.ts`.
 */

const request = {
  displayName: 'New bot',
  departmentId: '0192c3f0-1a2b-7c3d-8e4f-0000000000d1',
  welcomeEn: null,
  welcomeAr: null,
  languagePrompt: null,
  languagePick: true,
};

describe('MockTelegramApi', () => {
  it('refuses an unknown token and a bot that is already connected', async () => {
    const api = new MockTelegramApi();

    await expect(
      api.createBot('brand', { ...request, token: MOCK_REFUSED_TOKEN }),
    ).rejects.toMatchObject({ reason: 'token-invalid' });
    await api.createBot('brand', { ...request, token: MOCK_GOOD_TOKEN });
    await expect(
      api.createBot('brand', { ...request, token: MOCK_GOOD_TOKEN }),
    ).rejects.toMatchObject({ reason: 'bot-taken' });
  });

  it('keeps a replacement token to the same bot', async () => {
    const api = new MockTelegramApi();

    await expect(
      api.updateBot('brand', MOCK_SUPPORT_BOT, { ...request, token: MOCK_GOOD_TOKEN }),
    ).rejects.toMatchObject({ reason: 'token-other-bot' });
    await expect(
      api.updateBot('brand', MOCK_SUPPORT_BOT, { ...request, token: MOCK_REFUSED_TOKEN }),
    ).rejects.toMatchObject({ reason: 'token-invalid' });
  });

  it('keeps a bot’s own language prompt, and null for a blank one', async () => {
    const api = new MockTelegramApi();

    const own = await api.updateBot('brand', MOCK_SUPPORT_BOT, {
      ...request,
      languagePrompt: 'Pick a language · اختر لغتك',
    });
    const blanked = await api.updateBot('brand', MOCK_SUPPORT_BOT, {
      ...request,
      languagePrompt: '  ',
    });

    expect(own.languagePrompt).toBe('Pick a language · اختر لغتك');
    expect(blanked.languagePrompt).toBeNull();
  });

  it('sets a failing bot’s webhook and calls it healthy again', async () => {
    const api = new MockTelegramApi();

    expect((await api.status('brand', MOCK_BILLING_BOT)).webhook?.pendingUpdateCount).toBe(6);
    await api.setWebhook('brand', MOCK_BILLING_BOT);
    expect((await api.bot('brand', MOCK_BILLING_BOT)).health.state).toBe('healthy');
  });

  it('has a chat for the Telegram ticket only, and retries its refused reply', async () => {
    const api = new MockTelegramApi();

    expect(await api.ticketContext('brand', MOCK_TICKET_REFUND)).toEqual({
      context: null,
      deliveries: [],
    });
    const { deliveries } = await api.ticketContext('brand', MOCK_TICKET_ARABIC);
    const failed = deliveries.find((delivery) => delivery.status === 'failed');
    await api.retryDelivery('brand', MOCK_TICKET_ARABIC, failed?.id ?? '');
    expect(
      (await api.ticketContext('brand', MOCK_TICKET_ARABIC)).deliveries.map((d) => d.status),
    ).toEqual(['sent', 'sent']);
    await expect(api.retryDelivery('brand', MOCK_TICKET_REFUND, 'nope')).rejects.toThrow();
  });

  it('forgets a deleted bot', async () => {
    const api = new MockTelegramApi();

    await api.deleteBot('brand', MOCK_BILLING_BOT);
    await expect(api.bot('brand', MOCK_BILLING_BOT)).rejects.toThrow();
    expect((await api.bots('brand')).bots.map((bot) => bot.id)).toEqual([MOCK_SUPPORT_BOT]);
  });
});
