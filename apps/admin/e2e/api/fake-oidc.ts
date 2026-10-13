import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** Local OIDC authorization-code IdP. No request reaches a live identity provider. */
export async function fakeOidcIdp() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'test-key',
    use: 'sig',
    alg: 'RS256',
  };
  const grants = new Map<string, URLSearchParams>();
  const requests: { path: string; method: string }[] = [];
  const controls: {
    claims: Record<string, unknown>;
    badSignature: boolean;
    expired: boolean;
    wrongIssuer: boolean;
    wrongNonce: boolean;
    wrongAudience: boolean;
    tokenRedirect: boolean;
    privateJwks: boolean;
    userInfoSubject: string;
  } = {
    claims: {
      sub: 'staff-1',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada',
      groups: ['Support'],
    },
    badSignature: false,
    expired: false,
    wrongIssuer: false,
    wrongNonce: false,
    wrongAudience: false,
    tokenRedirect: false,
    privateJwks: false,
    userInfoSubject: 'staff-1',
  };
  let counter = 0;
  const issuer = 'http://127.0.0.1:8080';
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', issuer);
    requests.push({ path: url.pathname, method: request.method ?? 'GET' });
    if (url.pathname === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: controls.privateJwks ? 'http://169.254.169.254/jwks' : `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    } else if (url.pathname === '/authorize') {
      if (
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        url.searchParams.get('client_id') !== 'helpdock' ||
        url.searchParams.get('response_type') !== 'code'
      ) {
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      const code = `code-${++counter}`;
      grants.set(code, new URLSearchParams(url.searchParams));
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: callback.href });
      response.end();
    } else if (url.pathname === '/token') {
      if (controls.tokenRedirect) {
        response.writeHead(307, { location: `${issuer}/credential-leak` });
        response.end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const form = new URLSearchParams(body);
      const code = form.get('code') ?? '';
      const grant = grants.get(code);
      grants.delete(code);
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !grant ||
        grant.get('code_challenge') !== challenge ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_id') !== 'helpdock' ||
        form.get('client_secret') !== 'test-secret' ||
        form.get('redirect_uri') !== grant.get('redirect_uri')
      ) {
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          ...controls.claims,
          nonce: controls.wrongNonce ? 'wrong-nonce' : grant.get('nonce'),
          iss: controls.wrongIssuer ? 'https://wrong.example' : issuer,
          aud: controls.wrongAudience ? 'another-client' : 'helpdock',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + (controls.expired ? -120 : 300),
        }),
      ).toString('base64url');
      const data = `${header}.${payload}`;
      const token = `${data}.${sign('RSA-SHA256', Buffer.from(data), controls.badSignature ? stranger.privateKey : keys.privateKey).toString('base64url')}`;
      json(response, 200, {
        access_token: 'userinfo-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: token,
      });
    } else if (url.pathname === '/jwks') {
      json(response, 200, { keys: [jwk] });
    } else if (url.pathname === '/userinfo') {
      if (request.headers.authorization !== 'Bearer userinfo-token')
        json(response, 401, { error: 'invalid_token' });
      else
        json(response, 200, {
          ...controls.claims,
          sub: controls.userInfoSubject,
          name: controls.claims.name ?? 'Ada UserInfo',
          groups: controls.claims.groups ?? ['Support'],
        });
    } else json(response, 404, { error: 'not_found' });
  };
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => json(response, 500, { error: 'server_error' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(8080, '127.0.0.1', resolve);
  });
  return {
    issuer,
    controls,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    reset: () => {
      grants.clear();
      requests.length = 0;
      Object.assign(controls, {
        claims: {
          sub: 'staff-1',
          email: 'ada@example.com',
          email_verified: true,
          name: 'Ada',
          groups: ['Support'],
        },
        badSignature: false,
        expired: false,
        wrongIssuer: false,
        wrongNonce: false,
        wrongAudience: false,
        tokenRedirect: false,
        privateJwks: false,
        userInfoSubject: 'staff-1',
      });
    },
  };
}
