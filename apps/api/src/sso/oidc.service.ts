import { randomBytes } from 'node:crypto';
import { decryptSecret, type Env, type Keyring } from '@helpdock/config';
import { type Db, ssoConnections } from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import * as client from 'openid-client';
import { RateLimiter } from '../auth/rate-limit.js';
import type { Logger } from '../logging/logger.js';
import {
  matchesBrowserNonce,
  OidcFailure,
  oidcAssertion,
  oidcRequestSchema,
  ssoHash,
  ssoReturnToSchema,
} from './oidc-contracts.js';
import { oidcTransport, validateOidcEndpoints } from './oidc-transport.js';
import { SsoRequestStore } from './request-store.js';

const random = () => randomBytes(32).toString('base64url');
const configurationHash = (row: typeof ssoConnections.$inferSelect) =>
  ssoHash(
    JSON.stringify({
      config: row.config,
      secret: row.secretEncrypted,
      group: row.groupAttribute,
      updated: row.updatedAt.toISOString(),
    }),
  );

export class OidcService {
  private readonly store: SsoRequestStore<ReturnType<typeof oidcRequestSchema.parse>>;
  private readonly limiter: RateLimiter;
  private readonly cache = new Map<
    string,
    { hash: string; expires: number; configuration: client.Configuration }
  >();

  constructor(
    private readonly options: {
      db: Db;
      logger: Logger;
      redis: Redis;
      keyring: Keyring;
      env: Pick<Env, 'APP_URL' | 'OUTBOUND_ALLOW_CIDRS'>;
    },
  ) {
    this.store = new SsoRequestStore(options.redis, 'oidc', oidcRequestSchema);
    this.limiter = new RateLimiter(options.redis);
  }

  async start(input: { connectionId: string; returnTo: string; ip: string }) {
    if (
      !(await this.limiter.consume({ bucket: 'sso-start', limit: 20, windowSeconds: 60 }, input.ip))
    )
      throw new OidcFailure('sso-rate-limited');
    const returnTo = ssoReturnToSchema.parse(input.returnTo);
    const { row, config } = await this.connection(input.connectionId);
    const configuration = await this.configuration(row, config);
    const state = random();
    const nonce = random();
    const codeVerifier = client.randomPKCECodeVerifier();
    const browserNonce = random();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.callbackUrl(row.id),
      scope: config.scopes.join(' '),
      response_type: 'code',
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    await this.store.put(state, {
      connectionId: row.id,
      configurationHash: configurationHash(row),
      codeVerifier,
      nonce,
      browserNonceHash: ssoHash(browserNonce),
      returnTo,
    });
    return { url: url.toString(), browserNonce };
  }

  async complete(input: {
    connectionId: string;
    query: {
      state: string;
      code?: string | undefined;
      error?: string | undefined;
      iss?: string | undefined;
    };
    browserNonce: string | undefined;
    ip: string;
  }) {
    if (
      !(await this.limiter.consume(
        { bucket: 'sso-callback', limit: 40, windowSeconds: 60 },
        input.ip,
      ))
    )
      throw new OidcFailure('sso-rate-limited');
    const record = await this.store.consume(input.query.state);
    if (
      !record ||
      record.connectionId !== input.connectionId ||
      !matchesBrowserNonce(input.browserNonce, record.browserNonceHash)
    )
      throw new OidcFailure('sso-request-invalid');
    const { row, config } = await this.connection(input.connectionId);
    if (record.configurationHash !== configurationHash(row))
      throw new OidcFailure('sso-configuration-changed');
    const configuration = await this.configuration(row, config);
    const callback = new URL(this.callbackUrl(row.id));
    for (const [key, value] of Object.entries(input.query))
      if (value !== undefined) callback.searchParams.set(key, value);
    try {
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        pkceCodeVerifier: record.codeVerifier,
        expectedState: input.query.state,
        expectedNonce: record.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new OidcFailure('sso-token-invalid');
      let supplemental: Record<string, unknown> = {};
      // A distributed group claim is never fetched from a token-supplied URL.
      const overage = claims.hasgroups === true || claims._claim_names !== undefined;
      if (
        !overage &&
        configuration.serverMetadata().userinfo_endpoint &&
        tokens.access_token &&
        (claims[config.nameClaim] === undefined ||
          (row.groupAttribute && claims[row.groupAttribute] === undefined))
      ) {
        supplemental = await client.fetchUserInfo(configuration, tokens.access_token, claims.sub);
      }
      const assertion = oidcAssertion({
        connectionId: row.id,
        claims,
        supplemental,
        emailClaim: config.emailClaim,
        nameClaim: config.nameClaim,
        groupAttribute: row.groupAttribute,
      });
      return {
        assertion: { ...assertion, connectionRevision: row.updatedAt.toISOString() },
        returnTo: record.returnTo,
      };
    } catch (error) {
      if (error instanceof OidcFailure) {
        this.options.logger.warn(
          { connectionId: row.id, reason: error.code },
          'OIDC assertion refused',
        );
        throw error;
      }
      // Provider errors can contain tokens or client credentials; never retain/log them.
      this.options.logger.warn(
        { connectionId: row.id, reason: 'sso-token-invalid' },
        'OIDC callback refused',
      );
      throw new OidcFailure('sso-token-invalid');
    }
  }

  private callbackUrl(id: string): string {
    return new URL(`/api/auth/sso/${id}/oidc/callback`, this.options.env.APP_URL).toString();
  }

  private async connection(id: string) {
    // Explicit pre-tenant authentication read of install-global configuration.
    const [row] = await this.options.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, id));
    if (!row?.enabled) throw new OidcFailure('sso-connection-disabled');
    const config = ssoConnectionConfigSchema.parse(row.config);
    if (config.protocol !== 'oidc') throw new OidcFailure('sso-protocol-invalid');
    return { row, config };
  }

  private async configuration(
    row: typeof ssoConnections.$inferSelect,
    config: Extract<ReturnType<typeof ssoConnectionConfigSchema.parse>, { protocol: 'oidc' }>,
  ) {
    const hash = configurationHash(row);
    const cached = this.cache.get(row.id);
    if (cached && cached.hash === hash && cached.expires > Date.now()) return cached.configuration;
    const secret =
      row.secretEncrypted === null
        ? undefined
        : decryptSecret(row.secretEncrypted, this.options.keyring);
    const transport = oidcTransport(this.options.env.OUTBOUND_ALLOW_CIDRS);
    const configuration = await client.discovery(
      new URL(config.issuer),
      config.clientId,
      secret,
      secret === undefined ? client.None() : client.ClientSecretPost(secret),
      {
        [client.customFetch]: transport,
        execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks],
        timeout: 10,
      },
    );
    await validateOidcEndpoints(
      configuration.serverMetadata(),
      this.options.env.OUTBOUND_ALLOW_CIDRS,
    );
    for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(id);
    this.cache.set(row.id, { hash, expires: Date.now() + 3600_000, configuration });
    return configuration;
  }
}
