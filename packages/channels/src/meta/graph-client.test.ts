import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphApiFailure, GraphTokenFormatError } from './errors.js';
import { sha256Base64 } from './fixtures.js';
import {
  DEFAULT_META_GRAPH_API_ROOT,
  DEFAULT_META_GRAPH_VERSION,
  DEFAULT_META_INSTAGRAM_API_ROOT,
  GraphClient,
  graphApiFor,
  isAllowedGraphHost,
  multipartBody,
} from './graph-client.js';
import { FakeGraph } from './testing/fake-graph.js';

const WA_TOKEN = 'EAAGWA0123456789abcdefghij';
const PAGE_TOKEN = 'EAAGPG0123456789abcdefghij';
const IG_TOKEN = 'IGAAIG0123456789abcdefghij';
const PHONE_ID = '106540352242922';
const PAGE_ID = '112233445566778';
const IG_ID = '17841400000000000';

const graph = new FakeGraph();

const clientFor = (
  options: { version?: string; allowCidrs?: readonly string[] } = {},
): GraphClient =>
  new GraphClient({
    root: graph.facebookRoot,
    instagramRoot: graph.instagramRoot,
    allowCidrs: ['127.0.0.0/8'],
    ...options,
  });

const failureOf = async (work: Promise<unknown>): Promise<GraphApiFailure> => {
  const outcome = await work.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(GraphApiFailure);

  return outcome as GraphApiFailure;
};

beforeAll(async () => {
  await graph.start();
});

afterAll(async () => {
  await graph.stop();
});

beforeEach(() => {
  graph.reset();
  graph.connect({
    platform: 'whatsapp',
    id: PHONE_ID,
    name: 'Acme Support',
    wabaId: '102290129340398',
    token: WA_TOKEN,
  });
  graph.connect({ platform: 'messenger', id: PAGE_ID, name: 'Acme Page', token: PAGE_TOKEN });
  graph.connect({
    platform: 'instagram',
    id: IG_ID,
    name: 'Acme',
    username: 'acme',
    token: IG_TOKEN,
  });
});

describe('isAllowedGraphHost', () => {
  it.each([
    'graph.facebook.com',
    'graph.instagram.com',
    'lookaside.fbsbx.com',
    'scontent.xx.fbcdn.net',
    'scontent-fra5-1.xx.fbcdn.net',
    'GRAPH.FACEBOOK.COM',
    'graph.facebook.com.',
  ])('allows %s', (host) => {
    expect(isAllowedGraphHost(host)).toBe(true);
  });

  it.each([
    'facebook.com',
    'www.facebook.com',
    'evil.example.com',
    'graph.facebook.com.evil.example.com',
    'evilgraph.facebook.com.evil.test',
    'fbcdn.net',
    'xfbcdn.net',
    'fbcdn.net.evil.test',
    'lookaside.fbsbx.com.evil.test',
    'other.fbsbx.com',
    '127.0.0.1',
    'localhost',
    '',
  ])('refuses %s', (host) => {
    expect(isAllowedGraphHost(host)).toBe(false);
  });

  it('allows the host of a root an operator pointed at a stand-in, and only that one', () => {
    const roots = ['http://127.0.0.1:4010/facebook', 'http://127.0.0.1:4010/instagram'];

    expect(isAllowedGraphHost('127.0.0.1', roots)).toBe(true);
    expect(isAllowedGraphHost('127.0.0.2', roots)).toBe(false);
    // The roots replace the defaults rather than join them, and Meta's media
    // hosts stay allowed whatever the roots are.
    expect(isAllowedGraphHost('graph.facebook.com', roots)).toBe(false);
    expect(isAllowedGraphHost('scontent.xx.fbcdn.net', roots)).toBe(true);
    expect(isAllowedGraphHost('lookaside.fbsbx.com', roots)).toBe(true);
  });
});

describe('graphApiFor', () => {
  it('sends Instagram to its own host and the other two to Graph', () => {
    expect(graphApiFor('instagram')).toBe('instagram');
    expect(graphApiFor('whatsapp')).toBe('graph');
    expect(graphApiFor('messenger')).toBe('graph');
  });
});

describe('the defaults', () => {
  it('are the production hosts and the pinned version', () => {
    expect(DEFAULT_META_GRAPH_API_ROOT).toBe('https://graph.facebook.com');
    expect(DEFAULT_META_INSTAGRAM_API_ROOT).toBe('https://graph.instagram.com');
    expect(DEFAULT_META_GRAPH_VERSION).toBe('v25.0');
  });
});

describe('constructing a client', () => {
  it.each(['25.0', 'v25', 'latest', 'v25.0.1', ''])('refuses %s as a version', (version) => {
    expect(() => clientFor({ version })).toThrow(TypeError);
  });

  it('refuses a root that is not an http(s) URL', () => {
    expect(() => new GraphClient({ root: 'ftp://graph.example.com', allowCidrs: [] })).toThrow(
      'http(s) URL',
    );
    expect(() => new GraphClient({ root: 'graph', allowCidrs: [] })).toThrow(TypeError);
  });
});

describe('what a call looks like on the wire', () => {
  it('names the version in every path and sends the token as a bearer, not in the URL', async () => {
    await clientFor().get(`/${PHONE_ID}`, {
      token: WA_TOKEN,
      query: { fields: 'id,verified_name' },
    });

    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]).toMatchObject({
      root: 'facebook',
      method: 'GET',
      path: `/${PHONE_ID}`,
      version: 'v25.0',
      token: WA_TOKEN,
      query: { fields: 'id,verified_name' },
    });
    expect(graph.calls[0]?.query).not.toHaveProperty('access_token');
  });

  it('reaches a root an operator wrote with trailing slashes, without doubling them', async () => {
    const client = new GraphClient({
      root: `${graph.facebookRoot}///`,
      instagramRoot: `${graph.instagramRoot}/`,
      allowCidrs: ['127.0.0.0/8'],
    });
    await client.get(`/${PHONE_ID}`, { token: WA_TOKEN });
    await client.get('/me', { token: IG_TOKEN, api: 'instagram' });

    expect(graph.calls.map((call) => [call.root, call.path])).toEqual([
      ['facebook', `/${PHONE_ID}`],
      ['instagram', '/me'],
    ]);
  });

  it('names the version it was configured with', async () => {
    await clientFor({ version: 'v26.0' }).get(`/${PHONE_ID}`, { token: WA_TOKEN });

    expect(graph.calls[0]?.version).toBe('v26.0');
  });

  it('goes to the Instagram root when asked, and to Graph otherwise', async () => {
    const client = clientFor();
    await client.get('/me', { token: IG_TOKEN, api: 'instagram' });
    await client.get('/me', { token: PAGE_TOKEN });

    expect(graph.calls.map((call) => call.root)).toEqual(['instagram', 'facebook']);
  });

  it('sends a JSON body with its content type, and none for a call that has none', async () => {
    const client = clientFor();
    const body = { recipient: { id: '1' }, message: { text: 'Hello' } };
    await client
      .post(`/${PAGE_ID}/messages`, { token: PAGE_TOKEN, json: body })
      .catch(() => undefined);
    await client.post(`/${PAGE_ID}/subscribed_apps`, {
      token: PAGE_TOKEN,
      query: { subscribed_fields: 'messages' },
    });

    expect(graph.calls[0]?.body).toEqual(body);
    expect(graph.calls[1]).toMatchObject({
      method: 'POST',
      body: null,
      query: { subscribed_fields: 'messages' },
    });
  });

  it('answers the parsed JSON of a success', async () => {
    const identity = await clientFor().get(`/${PAGE_ID}`, { token: PAGE_TOKEN });

    expect(identity).toEqual({ id: PAGE_ID, name: 'Acme Page' });
  });

  it('can delete, as unsubscribing an app does', async () => {
    graph.subscribe(PAGE_ID);
    const answer = await clientFor().delete(`/${PAGE_ID}/subscribed_apps`, { token: PAGE_TOKEN });

    expect(answer).toEqual({ success: true });
    expect(graph.subscriptionOf(PAGE_ID)).toEqual([]);
  });

  it('leaves out a query value that is undefined', async () => {
    await clientFor().get(`/${PHONE_ID}`, {
      token: WA_TOKEN,
      query: { fields: undefined, limit: 3 },
    });

    expect(graph.calls[0]?.query).toEqual({ limit: '3' });
  });
});

describe('a path that is not a Graph path', () => {
  it.each([
    ['no leading slash', `${PHONE_ID}/messages`],
    ['a query string', `/${PHONE_ID}?fields=id`],
    ['a fragment', `/${PHONE_ID}#x`],
    ['a parent segment', `/${PHONE_ID}/../${PAGE_ID}`],
    ['a current segment', '/./me'],
    ['an empty segment', `/${PHONE_ID}//messages`],
    ['a space', '/me /messages'],
    ['an encoded slash', '/me%2Fmessages'],
    ['a backslash', '/me\\messages'],
    ['a newline', '/me\n/messages'],
    ['nothing', ''],
  ])('is refused before anything is sent: %s', async (_label, path) => {
    const refused = clientFor().get(path, { token: WA_TOKEN });

    await expect(refused).rejects.toThrow(TypeError);
    // A path is our own bug, never a token the person mistyped.
    await expect(refused).rejects.not.toBeInstanceOf(GraphTokenFormatError);
    expect(graph.calls).toEqual([]);
  });

  it('is refused for a token that could carry a second header', async () => {
    await expect(clientFor().get('/me', { token: `${WA_TOKEN}\r\nx-evil: 1` })).rejects.toThrow(
      GraphTokenFormatError,
    );
    await expect(clientFor().get('/me', { token: 'has a space' })).rejects.toThrow(
      GraphTokenFormatError,
    );
    expect(graph.calls).toEqual([]);
  });
});

describe('the host allow-list', () => {
  const unresolvable = async (): Promise<never> => {
    throw new Error('the client resolved a name it should have refused first');
  };

  it('refuses to download from a host that is not Meta’s, before resolving it', async () => {
    const client = new GraphClient({ allowCidrs: [], lookup: unresolvable });
    const failure = await failureOf(
      client.download('https://evil.example.com/file.jpg', { maxBytes: 1_000 }),
    );

    expect(failure).toMatchObject({ kind: 'permanent', reason: 'host-not-allowed' });
    expect(failure.detail).toContain('evil.example.com');
  });

  it('reports a host that is not Meta’s to the hook, with the host and no query string', async () => {
    const events: { code: string; host: string | undefined; url: string | undefined }[] = [];
    const client = new GraphClient({
      allowCidrs: [],
      lookup: unresolvable,
      onBlocked: (event) => events.push(event),
    });

    await failureOf(
      client.download('https://evil.example.com/file.jpg?signature=SECRET', { maxBytes: 1_000 }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        code: 'destination-blocked',
        host: 'evil.example.com',
        url: 'https://evil.example.com/file.jpg',
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });

  it('is not stopped by a hook that throws', async () => {
    const client = new GraphClient({
      allowCidrs: [],
      lookup: unresolvable,
      onBlocked: () => {
        throw new Error('the log is down');
      },
    });

    const failure = await failureOf(
      client.download('https://evil.example.com/file.jpg', { maxBytes: 1_000 }),
    );

    expect(failure.reason).toBe('host-not-allowed');
  });

  it('refuses a look-alike of a Meta host', async () => {
    const client = new GraphClient({ allowCidrs: [], lookup: unresolvable });

    for (const url of [
      'https://graph.facebook.com.evil.test/x',
      'https://scontent.fbcdn.net.evil.test/x',
      'https://fbcdn.net/x',
    ]) {
      expect((await failureOf(client.download(url, { maxBytes: 1_000 }))).reason).toBe(
        'host-not-allowed',
      );
    }
  });

  it('refuses something that is not a URL', async () => {
    const failure = await failureOf(clientFor().download('not a url', { maxBytes: 1_000 }));

    expect(failure.reason).toBe('host-not-allowed');
  });

  it('refuses an address on Meta’s CDN that resolves into a private range, through safeFetch', async () => {
    const blocked: string[] = [];
    const client = new GraphClient({
      allowCidrs: [],
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      onBlocked: (event) => blocked.push(event.code),
    });
    const failure = await failureOf(
      client.download('https://scontent.xx.fbcdn.net/v/photo.jpg', { maxBytes: 1_000 }),
    );

    expect(failure).toMatchObject({ kind: 'permanent', reason: 'blocked' });
    expect(blocked).toEqual(['destination-blocked']);
  });

  it('does not reach a stand-in on a loopback address unless the operator allowed the range', async () => {
    const client = new GraphClient({
      root: graph.facebookRoot,
      instagramRoot: graph.instagramRoot,
      allowCidrs: [],
    });

    expect((await failureOf(client.get(`/${PHONE_ID}`, { token: WA_TOKEN }))).reason).toBe(
      'blocked',
    );
    expect(graph.calls).toEqual([]);
  });

  it('refuses a redirect, because the host it names was never checked', async () => {
    graph.failures.push({ status: 302, headers: { location: 'https://evil.example.com/' } });
    const failure = await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }));

    expect(failure).toMatchObject({ kind: 'permanent', reason: 'blocked' });
    expect(failure.detail).toMatch(/redirect/i);
  });
});

describe('what a refusal becomes', () => {
  it('reads an unknown token as a dead one, from the HTTP status and Graph’s code', async () => {
    const failure = await failureOf(
      clientFor().get(`/${PHONE_ID}`, { token: 'nobody-0123456789abcdef' }),
    );

    expect(failure).toMatchObject({ kind: 'token_dead', code: 190, status: 401, permanent: true });
  });

  it('reads an expired token as a dead one', async () => {
    graph.expiredTokens.add(WA_TOKEN);
    const failure = await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }));

    expect(failure).toMatchObject({ kind: 'token_dead', code: 190, subcode: 463 });
  });

  it('reads a closed window as a closed window, on each platform’s own code', async () => {
    graph.windowClosed.add('16505551234').add('7654321098765432');
    const client = clientFor();
    const whatsapp = await failureOf(
      client.post(`/${PHONE_ID}/messages`, {
        token: WA_TOKEN,
        json: {
          messaging_product: 'whatsapp',
          to: '16505551234',
          type: 'text',
          text: { body: 'Hi' },
        },
      }),
    );
    const messenger = await failureOf(
      client.post(`/${PAGE_ID}/messages`, {
        token: PAGE_TOKEN,
        json: {
          recipient: { id: '7654321098765432' },
          messaging_type: 'RESPONSE',
          message: { text: 'Hi' },
        },
      }),
    );

    expect(whatsapp).toMatchObject({ kind: 'window_closed', code: 131_047, permanent: true });
    expect(messenger).toMatchObject({ kind: 'window_closed', code: 10, subcode: 2_018_278 });
  });

  it('reads the pair limit as a rate limit worth another attempt', async () => {
    graph.pairLimited.add('16505551234');
    const failure = await failureOf(
      clientFor().post(`/${PHONE_ID}/messages`, {
        token: WA_TOKEN,
        json: {
          messaging_product: 'whatsapp',
          to: '16505551234',
          type: 'text',
          text: { body: 'Hi' },
        },
      }),
    );

    expect(failure).toMatchObject({ kind: 'rate_limited', code: 131_056, permanent: false });
  });

  it('reads a blocked recipient as permanent', async () => {
    graph.blocked.add('7654321098765432');
    const failure = await failureOf(
      clientFor().post(`/${PAGE_ID}/messages`, {
        token: PAGE_TOKEN,
        json: {
          recipient: { id: '7654321098765432' },
          messaging_type: 'RESPONSE',
          message: { text: 'Hi' },
        },
      }),
    );

    expect(failure).toMatchObject({ kind: 'permanent', code: 551, permanent: true });
  });

  it('reads a 5xx as Graph failing, to be retried', async () => {
    graph.failures.push({ status: 503 });
    const failure = await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }));

    expect(failure).toMatchObject({ kind: 'retry', status: 503, permanent: false, code: null });
  });

  it('reads a 429 with no body as a rate limit', async () => {
    graph.failures.push({ status: 429 });

    expect((await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }))).kind).toBe(
      'rate_limited',
    );
  });

  it('reads a 2xx that is not JSON as Graph failing, not as a success', async () => {
    graph.failures.push({ status: 200, body: undefined });
    const failure = await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }));

    expect(failure).toMatchObject({ kind: 'retry', status: 200 });
  });

  it('reads an unreachable Graph as a transport failure, to be retried', async () => {
    const closed = new GraphClient({
      root: 'http://127.0.0.1:9',
      instagramRoot: 'http://127.0.0.1:9',
      allowCidrs: ['127.0.0.0/8'],
    });
    const failure = await failureOf(closed.get('/me', { token: WA_TOKEN }));

    expect(failure).toMatchObject({ kind: 'retry', reason: 'transport', permanent: false });
  });

  it('refuses an answer past the 1 MiB a Graph call is allowed, as permanent', async () => {
    graph.failures.push({ status: 200, body: { data: 'x'.repeat(1_100_000) } });
    const failure = await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }));

    expect(failure).toMatchObject({ kind: 'permanent', reason: 'too-large' });
  });
});

describe('the token never appears in what a failure says', () => {
  it('is taken out of Graph’s own sentence, wherever it quoted it', async () => {
    graph.failures.push({
      status: 400,
      body: {
        error: {
          code: 100,
          message: `Bad ${WA_TOKEN} in Bearer ${WA_TOKEN} and access_token=${WA_TOKEN}`,
        },
      },
    });
    const failure = await failureOf(clientFor().get(`/${PHONE_ID}`, { token: WA_TOKEN }));

    expect(failure.detail).not.toContain(WA_TOKEN);
    expect(failure.message).not.toContain(WA_TOKEN);
    expect(JSON.stringify(failure)).not.toContain(WA_TOKEN);
  });
});

describe('uploading', () => {
  it('posts one file and its text fields as multipart, and answers the media id', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0xff, 0x00]);
    const answer = await clientFor().postMultipart(`/${PHONE_ID}/media`, {
      token: WA_TOKEN,
      fields: { messaging_product: 'whatsapp', type: 'application/pdf' },
      file: { name: 'invoice.pdf', contentType: 'application/pdf', bytes },
    });
    const id = (answer as { id: string }).id;

    expect(id).toMatch(/^FAKEMEDIA/);
    expect(graph.uploads.get(id)).toEqual({
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      bytes,
    });
    expect(graph.calls[0]?.body).toMatchObject({
      fields: { messaging_product: 'whatsapp', type: 'application/pdf' },
    });
  });

  it('survives a file name that tries to close its own quotes', async () => {
    const answer = await clientFor().postMultipart(`/${PHONE_ID}/media`, {
      token: WA_TOKEN,
      fields: { messaging_product: 'whatsapp' },
      file: {
        name: 'a"; name="evil\r\nx: y.png',
        contentType: 'image/png',
        bytes: Buffer.from('png'),
      },
    });

    expect(graph.uploads.get((answer as { id: string }).id)?.name).toBe('a_; name=_evil__x: y.png');
  });
});

describe('multipartBody', () => {
  it('writes each field, then the file with its type, then the closing boundary, as CRLF text', () => {
    const body = Buffer.from(
      multipartBody(
        'BOUNDARY',
        { a: '1', b: '2' },
        { name: 'f.bin', contentType: 'application/octet-stream', bytes: Buffer.from([1, 2, 3]) },
      ),
    );
    const text = body.toString('latin1');

    expect(
      text.startsWith('--BOUNDARY\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n'),
    ).toBe(true);
    expect(text).toContain('--BOUNDARY\r\nContent-Disposition: form-data; name="b"\r\n\r\n2\r\n');
    expect(text).toContain(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\u0001\u0002\u0003\r\n--BOUNDARY--\r\n',
    );
  });

  it('keeps the file’s bytes exactly, even ones that are not text', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const body = Buffer.from(
      multipartBody('B', {}, { name: 'all.bin', contentType: 'x/y', bytes }),
    );
    const start = body.indexOf(Buffer.from('\r\n\r\n')) + 4;

    expect(body.subarray(start, start + 256)).toEqual(Buffer.from(bytes));
  });

  it('cannot be made to inject a field through a field name', () => {
    const text = Buffer.from(
      multipartBody(
        'B',
        { 'x"\r\n\r\ninjected': 'v' },
        { name: 'f', contentType: 'x/y', bytes: new Uint8Array() },
      ),
    ).toString('utf8');

    expect(text).not.toContain('\r\ninjected');
  });
});

describe('downloading', () => {
  const bytes = Buffer.from('ÿØÿJPEG'.repeat(200), 'latin1');

  it('fetches a WhatsApp media URL with the account’s token, as Meta requires', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    const client = clientFor();
    const meta = (await client.get('/555', { token: WA_TOKEN })) as { url: string };
    const file = await client.download(meta.url, { token: WA_TOKEN, maxBytes: 10_000 });

    expect(file.bytes).toEqual(bytes);
    expect(file.contentType).toBe('image/jpeg');
    expect(graph.mediaRequests).toEqual([
      { kind: 'media', name: '555', authorization: `Bearer ${WA_TOKEN}` },
    ]);
  });

  it('fetches an attachment from a CDN with no token, even when it was given one', async () => {
    const url = graph.serveCdn('photo.jpg', bytes, 'image/jpeg');
    // The stand-in's own address is a Graph root, where the token is welcome;
    // a CDN name is the case the rule is for, reached through a resolver that
    // maps it onto the stand-in.
    const cdnUrl = url.replace('127.0.0.1', 'scontent.xx.fbcdn.net');
    const client = new GraphClient({
      root: graph.facebookRoot,
      instagramRoot: graph.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const file = await client.download(cdnUrl, { token: WA_TOKEN, maxBytes: 10_000 });

    expect(file.bytes).toEqual(bytes);
    expect(graph.mediaRequests).toEqual([{ kind: 'cdn', name: 'photo.jpg', authorization: null }]);
  });

  it('refuses a body past the cap as it arrives', async () => {
    const url = graph.serveCdn('big.bin', Buffer.alloc(2_048, 1), 'application/octet-stream');
    const failure = await failureOf(clientFor().download(url, { maxBytes: 1_024 }));

    expect(failure).toMatchObject({ kind: 'permanent', reason: 'too-large' });
  });

  it('accepts a body of exactly the cap', async () => {
    const url = graph.serveCdn('exact.bin', Buffer.alloc(1_024, 1), 'application/octet-stream');

    expect((await clientFor().download(url, { maxBytes: 1_024 })).bytes).toHaveLength(1_024);
  });

  it('keeps the 404 of media that expired, so the job can tell it from a refusal', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    graph.expiredMedia.add('555');
    const failure = await failureOf(
      clientFor().download(`${graph.url}/media/555`, { token: WA_TOKEN, maxBytes: 10_000 }),
    );

    expect(failure).toMatchObject({ status: 404, kind: 'permanent' });
  });

  it('is refused by a token the stand-in does not know', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    const failure = await failureOf(
      clientFor().download(`${graph.url}/media/555`, {
        token: 'nobody-0123456789abcdef',
        maxBytes: 10_000,
      }),
    );

    expect(failure).toMatchObject({ status: 401 });
  });

  it('checks the digest a WhatsApp webhook carried against what was fetched', async () => {
    graph.serveMedia('555', bytes, 'image/jpeg');
    const meta = (await clientFor().get('/555', { token: WA_TOKEN })) as {
      url: string;
      sha256: string;
    };
    const file = await clientFor().download(meta.url, { token: WA_TOKEN, maxBytes: 10_000 });

    // The webhook writes the digest in base64 and this endpoint in hex.
    expect(Buffer.from(sha256Base64(file.bytes), 'base64').toString('hex')).toBe(meta.sha256);
  });
});
