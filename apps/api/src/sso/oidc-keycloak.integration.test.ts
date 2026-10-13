import { createServer, type Server } from 'node:http';
import 'reflect-metadata';
import { createKeyring, encryptSecret } from '@helpdock/config';
import { createDb, type DbHandle, ssoConnections, users, uuidv7 } from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { type Browser, chromium } from 'playwright';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../bootstrap.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { silentLogger } from '../testing/silent-logger.js';
import { OidcService } from './oidc.service.js';

const CONNECTION = uuidv7();
const USER = uuidv7();
const SUBJECT = uuidv7();
const ISSUER = 'http://127.0.0.1:8443/realms/helpdock-test';
const APP_URL = 'http://127.0.0.1:3126';
const KEY = Buffer.alloc(32, 93).toString('base64');

// This optional real-provider smoke test complements the deterministic fake-IdP
// CI attack suite. Run explicitly; it needs the Keycloak image and Chromium.
const enabled = process.env.HD_TEST_KEYCLOAK === '1';

describe.skipIf(!hasDocker || !enabled)('M11-02 real Docker Keycloak', () => {
  let keycloak: StartedTestContainer;
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let runtime: Runtime;
  let owner: DbHandle;
  let browser: Browser;
  let oidc: OidcService;
  let callbackServer: Server;

  beforeAll(async () => {
    callbackServer = createServer((_request, response) => {
      response.end('OIDC callback received');
    });
    await new Promise<void>((resolve, reject) => {
      callbackServer.once('error', reject);
      callbackServer.listen(3126, '127.0.0.1', resolve);
    });
    const realm = {
      realm: 'helpdock-test',
      enabled: true,
      sslRequired: 'none',
      groups: [{ name: 'Support' }],
      users: [
        {
          id: SUBJECT,
          username: 'ada',
          email: 'ada@example.com',
          emailVerified: true,
          firstName: 'Ada',
          lastName: 'Test',
          enabled: true,
          groups: ['/Support'],
          credentials: [{ type: 'password', value: 'local-test-password', temporary: false }],
        },
      ],
      clients: [
        {
          clientId: 'helpdock',
          secret: 'test-secret',
          enabled: true,
          publicClient: false,
          standardFlowEnabled: true,
          redirectUris: [`${APP_URL}/api/auth/sso/${CONNECTION}/oidc/callback`],
          defaultClientScopes: ['email', 'profile'],
          attributes: { 'pkce.code.challenge.method': 'S256' },
          protocolMappers: [
            {
              name: 'groups',
              protocol: 'openid-connect',
              protocolMapper: 'oidc-group-membership-mapper',
              consentRequired: false,
              config: {
                'claim.name': 'groups',
                'full.path': 'false',
                'id.token.claim': 'true',
                'access.token.claim': 'true',
                'userinfo.token.claim': 'true',
              },
            },
          ],
        },
      ],
    };
    keycloak = await new GenericContainer('quay.io/keycloak/keycloak:26.8.0')
      .withCopyContentToContainer([
        {
          content: JSON.stringify(realm),
          target: '/opt/keycloak/data/import/helpdock-test-realm.json',
        },
      ])
      .withExposedPorts({ container: 8080, host: 8443 })
      .withCommand(['start-dev', '--import-realm', '--hostname=http://127.0.0.1:8443'])
      .withWaitStrategy(Wait.forLogMessage(/Listening on: http:\/\/0\.0\.0\.0:8080/))
      .withStartupTimeout(180000)
      .start();
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    const env = {
      ...metaEnv({
        masterKey: KEY,
        postgres,
        redis,
        graph: { facebookRoot: ISSUER, instagramRoot: ISSUER },
      }),
      APP_URL,
    };
    runtime = await createRuntime({ env, logger: silentLogger() });
    owner = createDb({ url: postgres.getConnectionUri() });
    await owner.db.insert(users).values({ id: USER, email: 'ada@example.com', name: 'Ada' });
    await owner.db.insert(ssoConnections).values({
      id: CONNECTION,
      name: 'Keycloak',
      protocol: 'oidc',
      enabled: true,
      groupAttribute: 'groups',
      createdBy: USER,
      config: ssoConnectionConfigSchema.parse({
        protocol: 'oidc',
        issuer: ISSUER,
        clientId: 'helpdock',
      }),
      secretEncrypted: encryptSecret('test-secret', createKeyring({ APP_MASTER_KEY: KEY })),
    });
    oidc = new OidcService({
      db: runtime.db,
      redis: runtime.redis,
      keyring: createKeyring(env),
      env,
      logger: silentLogger(),
    });
    browser = await chromium.launch();
  }, 300000);

  afterAll(async () => {
    await browser?.close();
    callbackServer?.closeAllConnections();
    if (callbackServer)
      await new Promise<void>((resolve, reject) =>
        callbackServer.close((error) => (error ? reject(error) : resolve())),
      );
    await runtime?.close();
    await owner?.close();
    await redis?.stop();
    await postgres?.stop();
    await keycloak?.stop();
  });

  it('signs in through the real provider login page and validates its signed claims', async () => {
    const started = await oidc.start({
      connectionId: CONNECTION,
      returnTo: '/tickets',
      ip: 'keycloak-test',
    });
    const page = await browser.newPage();
    try {
      await page.goto(started.url);
      await page.locator('#username').fill('ada');
      await page.locator('#password').fill('local-test-password');
      await page.locator('#kc-login').click();
      await page.waitForURL(`${APP_URL}/api/auth/sso/**`, { timeout: 10000 });
      const url = new URL(page.url());
      const completed = await oidc.complete({
        connectionId: CONNECTION,
        query: {
          state: url.searchParams.get('state') ?? '',
          code: url.searchParams.get('code') ?? '',
          ...(url.searchParams.has('iss') ? { iss: url.searchParams.get('iss') ?? '' } : {}),
        },
        browserNonce: started.browserNonce,
        ip: 'keycloak-test',
      });
      expect(completed.assertion).toMatchObject({
        subject: SUBJECT,
        email: 'ada@example.com',
        emailVerified: true,
        groups: ['Support'],
      });
      expect(completed.returnTo).toBe('/tickets');
      await expect(
        oidc.complete({
          connectionId: CONNECTION,
          query: {
            state: url.searchParams.get('state') ?? '',
            code: url.searchParams.get('code') ?? '',
          },
          browserNonce: started.browserNonce,
          ip: 'keycloak-test',
        }),
      ).rejects.toThrow('sso-request-invalid');
    } finally {
      await page.close();
    }
  }, 60000);
});
