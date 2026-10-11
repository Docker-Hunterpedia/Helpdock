import { FakeGraph, GraphClient } from '@helpdock/channels';
import { createKeyring, encryptSecret } from '@helpdock/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { graphForAccount, graphForToken } from './graph-factory.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });
const TOKEN = 'IGAAinstagramUserToken000000001';
const PAGE_TOKEN = 'EAAGmessengerPageToken000000001';
const PAGE = '112233445566778';

describe('graphForAccount and graphForToken', () => {
  const stub = new FakeGraph();
  const factory = () =>
    new GraphClient({
      root: stub.facebookRoot,
      instagramRoot: stub.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
    });

  beforeAll(async () => {
    await stub.start();
    stub.connect({
      platform: 'instagram',
      id: '17841400000000000',
      name: 'Helpdock',
      username: 'helpdock',
      token: TOKEN,
    });
    stub.connect({ platform: 'messenger', id: PAGE, name: 'Page', token: PAGE_TOKEN });
  });

  afterAll(async () => {
    await stub.stop();
  });

  beforeEach(() => {
    stub.reset();
  });

  it('decrypts the stored token for the call and sends it only as the bearer', async () => {
    const graph = graphForAccount(
      { platform: 'instagram', accessToken: encryptSecret(TOKEN, keyring) },
      keyring,
      factory,
    );

    await graph.get('/me', { fields: 'id' });

    expect(stub.calls[0]).toMatchObject({
      root: 'instagram',
      token: TOKEN,
      query: { fields: 'id' },
    });
  });

  it('puts an Instagram account on the Instagram host and the others on Graph', async () => {
    await graphForToken('messenger', PAGE_TOKEN, factory).get('/me', { fields: 'id' });
    await graphForToken('instagram', TOKEN, factory).get('/me', { fields: 'id' });

    expect(stub.calls.map((call) => call.root)).toEqual(['facebook', 'instagram']);
  });

  it('asks the other host with the same token', async () => {
    await graphForToken('messenger', TOKEN, factory).onOtherHost().get('/me', { fields: 'id' });

    expect(stub.calls[0]).toMatchObject({ root: 'instagram', token: TOKEN });
  });

  it('names its token as a parameter only for debug_token', async () => {
    await graphForToken('messenger', PAGE_TOKEN, factory).debugToken();

    expect(stub.calls[0]).toMatchObject({
      path: '/debug_token',
      query: { input_token: PAGE_TOKEN },
    });
  });

  it('subscribes and unsubscribes with the fields as a query, and no body', async () => {
    const graph = graphForToken('messenger', PAGE_TOKEN, factory);

    await graph.post(`/${PAGE}/subscribed_apps`, { query: { subscribed_fields: 'messages' } });
    await graph.delete(`/${PAGE}/subscribed_apps`);

    expect(stub.calls.map((call) => [call.method, call.query.subscribed_fields ?? null])).toEqual([
      ['POST', 'messages'],
      ['DELETE', null],
    ]);
  });

  it('serialises to its platform and nothing else, so a log line cannot carry the token', () => {
    const graph = graphForToken('instagram', TOKEN, factory);

    expect(JSON.stringify(graph)).toBe('{"platform":"instagram"}');
    expect(JSON.stringify({ graph })).not.toContain(TOKEN);
    expect(Object.values(graph)).not.toContain(TOKEN);
  });
});
