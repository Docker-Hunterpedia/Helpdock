import { GraphClient } from '@helpdock/channels';
import { FakeGraph } from '@helpdock/channels/testing';
import { createKeyring, encryptSecret } from '@helpdock/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountGraph, graphForAccount, graphForToken } from './account-graph.js';

const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') });
const TOKEN = 'IGAAinstagramUserToken000000001';
const PAGE_TOKEN = 'EAAGmessengerPageToken000000001';
const PAGE = '112233445566778';

describe('graphForAccount and graphForToken', () => {
  const stub = new FakeGraph();
  // Built once the stand-in is listening: its roots are its own addresses.
  let factory: GraphClient;

  beforeAll(async () => {
    await stub.start();
    factory = new GraphClient({
      root: stub.facebookRoot,
      instagramRoot: stub.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
    });
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

  it('takes its own token out of a message, and leaves the rest', () => {
    const graph = graphForToken('instagram', TOKEN, factory);

    expect(graph.redact(`Graph refused ${TOKEN} for this call`)).toBe(
      'Graph refused <token> for this call',
    );
    expect(graph.redact('nothing to hide')).toBe('nothing to hide');
  });

  it('uploads a file and downloads bytes with its token, and a link without it', async () => {
    const whatsapp = new FakeGraph();
    await whatsapp.start();
    try {
      whatsapp.connect({
        platform: 'whatsapp',
        id: '106540352242922',
        name: 'Acme',
        displayPhone: '+1 555 0100',
        wabaId: '102290129340398',
        token: 'EAAGwhatsappToken0000000001',
      });
      whatsapp.media.set('MEDIA1', { bytes: Buffer.from('bytes'), mimeType: 'image/jpeg' });
      const client = new GraphClient({
        root: whatsapp.facebookRoot,
        instagramRoot: whatsapp.instagramRoot,
        allowCidrs: ['127.0.0.0/8'],
      });
      const graph = new AccountGraph(client, 'whatsapp', 'EAAGwhatsappToken0000000001');

      const uploaded = await graph.postMultipart('/106540352242922/media', {
        fields: { messaging_product: 'whatsapp', type: 'image/jpeg' },
        file: { name: 'a.jpg', contentType: 'image/jpeg', bytes: Buffer.from('JPEG') },
      });
      const description = (await graph.get('/MEDIA1')) as { url: string };
      const downloaded = await graph.download(description.url, { maxBytes: 1_000 });
      const link = whatsapp.serveCdn('photo.jpg', Buffer.from('cdn bytes'), 'image/jpeg');
      const linked = await graph.downloadLink(link, { maxBytes: 1_000 });

      expect(uploaded).toMatchObject({ id: expect.stringMatching(/^FAKEMEDIA/) });
      expect(downloaded.bytes).toEqual(Buffer.from('bytes'));
      expect(linked.bytes).toEqual(Buffer.from('cdn bytes'));
      // The media request carried the bearer; the link did not.
      expect(whatsapp.mediaRequests.map((request) => request.authorization)).toEqual([
        'Bearer EAAGwhatsappToken0000000001',
        null,
      ]);
    } finally {
      await whatsapp.stop();
    }
  });

  it('serialises to its platform and nothing else, so a log line cannot carry the token', () => {
    const graph = graphForToken('instagram', TOKEN, factory);

    expect(JSON.stringify(graph)).toBe('{"platform":"instagram"}');
    expect(JSON.stringify({ graph })).not.toContain(TOKEN);
    expect(Object.values(graph)).not.toContain(TOKEN);
  });
});
