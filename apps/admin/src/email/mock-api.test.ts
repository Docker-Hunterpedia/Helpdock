import { describe, expect, it } from 'vitest';
import { isAuthError } from '../auth/api.js';
import { MOCK_FAILED_SEND, MOCK_UNDELIVERED_MESSAGE, MockEmailApi } from './mock-api.js';

const BRAND = 'brand';

describe('MockEmailApi', () => {
  it('keeps a stored password when a save sends none, and forgets it when one is cleared', async () => {
    const api = new MockEmailApi();
    const server = { host: 'smtp.example.com', port: 587, tls: 'starttls' as const, user: 'u' };

    expect((await api.saveSmtp(BRAND, server)).smtp?.passwordSet).toBe(true);
    expect((await api.saveSmtp(BRAND, { ...server, password: '' })).smtp?.passwordSet).toBe(false);
  });

  it('refuses the sign-in of a host with "fail" in it, and accepts any other', async () => {
    const api = new MockEmailApi();

    expect(
      await api.testSmtp(BRAND, { host: 'fail.example', port: 25, tls: 'none', user: '' }),
    ).toMatchObject({ delivered: false, error: 'auth-failed' });
    expect(
      (await api.testSmtp(BRAND, { host: 'ok.example', port: 25, tls: 'none', user: '' }))
        .delivered,
    ).toBe(true);
  });

  it('empties Failed sends by retry, discard and retry all', async () => {
    const api = new MockEmailApi();

    await api.discardFailedSend(BRAND, MOCK_FAILED_SEND);
    expect((await api.failedSends(BRAND)).items).toHaveLength(1);
    await expect(api.retryFailedSend(BRAND, MOCK_FAILED_SEND)).rejects.toSatisfy(isAuthError);
    expect(await api.retryAllFailedSends(BRAND)).toBe(1);
    expect((await api.failedSends(BRAND)).items).toEqual([]);
  });

  it('refuses a signature of seven lines, as the api does', async () => {
    const api = new MockEmailApi();

    await expect(api.saveSignature({ en: '1\n2\n3\n4\n5\n6\n7', ar: '' })).rejects.toSatisfy(
      isAuthError,
    );
    expect(await api.saveSignature({ en: 'Lina', ar: '' })).toEqual({ en: 'Lina', ar: '' });
  });

  it('offers the senders it holds to the composer, and puts a failed reply back when retried', async () => {
    const api = new MockEmailApi();
    await api.saveSignature({ en: '', ar: '' });

    const before = await api.ticketEmail(BRAND, 'ticket');
    expect(before.senders.map((sender) => sender.key)[0]).toBe('default');
    expect(before.signature).toBeNull();
    expect(before.deliveries[0]).toMatchObject({
      messageId: MOCK_UNDELIVERED_MESSAGE,
      status: 'failed',
    });

    await api.retryMessage(BRAND, 'ticket', MOCK_UNDELIVERED_MESSAGE);
    await api.retryMessage(BRAND, 'ticket', 'unknown');
    expect((await api.ticketEmail(BRAND, 'ticket')).deliveries[0]?.status).toBe('queued');
  });

  it('saves senders and auto-replies whole', async () => {
    const api = new MockEmailApi();
    const settings = await api.outgoing(BRAND);

    const senders = await api.saveSenders(BRAND, { defaultFrom: null, departments: [] });
    const replies = await api.saveAutoReplies(BRAND, {
      ...settings.autoReplies,
      perSenderHourlyCap: 9,
    });

    expect(senders.senders).toEqual({ defaultFrom: null, departments: [] });
    expect(replies.autoReplies.perSenderHourlyCap).toBe(9);
    expect((await api.ticketEmail(BRAND, 'ticket')).selectedKey).toBeNull();
  });
});
