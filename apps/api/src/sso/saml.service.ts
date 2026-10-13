import { randomBytes } from 'node:crypto';
import type { Env } from '@helpdock/config';
import { type Db, ssoConnections } from '@helpdock/db';
import { ssoConnectionConfigSchema } from '@helpdock/schemas';
import { generateServiceProviderMetadata, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { RateLimiter } from '../auth/rate-limit.js';
import type { Logger } from '../logging/logger.js';
import { matchesBrowserNonce, ssoHash, ssoReturnToSchema } from './oidc-contracts.js';
import { validateSsoEndpoint } from './oidc-transport.js';
import { SsoRequestStore } from './request-store.js';
import { claimSamlResponse, SamlCache } from './saml-cache.js';
import {
  samlAcsSchema,
  samlAssertion,
  samlPendingSchema,
  samlRequestSchema,
} from './saml-contracts.js';
import { samlResponseXml } from './saml-crypto-policy.js';
import {
  SAML_METADATA_NS,
  SAML_PROTOCOL_NS,
  SamlFailure,
  samlChild,
  samlDocument,
} from './saml-xml.js';
import type { SsoService } from './sso.service.js';

const random = () => randomBytes(32).toString('base64url');
export const samlNameIdFormat = (format: string) =>
  `urn:oasis:names:tc:SAML:${format === 'persistent' ? '2.0' : '1.1'}:nameid-format:${format}`;
const configurationHash = (row: typeof ssoConnections.$inferSelect) =>
  ssoHash(
    JSON.stringify({
      config: row.config,
      domains: row.emailDomains,
      groups: row.groupAttribute,
      updated: row.updatedAt.toISOString(),
    }),
  );

export class SamlService {
  private readonly requests;
  private readonly pending;
  private readonly limiter;
  constructor(
    private readonly options: {
      db: Db;
      redis: Redis;
      env: Pick<Env, 'APP_URL' | 'OUTBOUND_ALLOW_CIDRS'>;
      logger: Logger;
      sso: SsoService;
    },
  ) {
    this.requests = new SsoRequestStore(options.redis, 'saml', samlRequestSchema);
    this.pending = new SsoRequestStore(options.redis, 'saml-pending', samlPendingSchema);
    this.limiter = new RateLimiter(options.redis);
  }

  private async limit(bucket: string, ip: string, limit: number) {
    if (!(await this.limiter.consume({ bucket, limit, windowSeconds: 60 }, ip)))
      throw new SamlFailure('sso-rate-limited');
  }
  private acsUrl(id: string) {
    return new URL(`/api/auth/sso/${id}/saml/acs`, this.options.env.APP_URL).toString();
  }
  private entityId() {
    return new URL('/api/auth/sso/saml/metadata', this.options.env.APP_URL).toString();
  }
  private async connection(id: string) {
    // Explicit pre-tenant authentication read of install-global configuration.
    const [row] = await this.options.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, id));
    if (!row?.enabled) throw new SamlFailure('sso-connection-disabled');
    const config = ssoConnectionConfigSchema.parse(row.config);
    if (config.protocol !== 'saml') throw new SamlFailure('sso-protocol-invalid');
    return { row, config };
  }
  private async protocol(
    connection: Awaited<ReturnType<SamlService['connection']>>,
    requestId?: string,
  ) {
    const { row, config } = connection;
    const keys = await this.options.sso.spKeys();
    return new SAML({
      issuer: this.entityId(),
      audience: this.entityId(),
      callbackUrl: this.acsUrl(row.id),
      entryPoint: config.idpSsoUrl,
      idpCert: config.idpCertificates,
      idpIssuer: config.idpEntityId,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      privateKey: keys.privateKey,
      publicCert: keys.certificate,
      decryptionPvk: keys.privateKey,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      identifierFormat: samlNameIdFormat(config.nameIdFormat),
      disableRequestedAuthnContext: true,
      acceptedClockSkewMs: config.clockSkewSeconds * 1000,
      maxAssertionAgeMs: 600000,
      validateInResponseTo: config.allowIdpInitiated
        ? ValidateInResponseTo.ifPresent
        : ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 600000,
      cacheProvider: new SamlCache(this.options.redis, row.id),
      ...(requestId ? { generateUniqueId: () => requestId } : {}),
    });
  }

  async start(input: {
    connectionId: string;
    returnTo: string;
    ip: string;
    expectedSubject?: string;
  }) {
    await this.limit('sso-start', input.ip, 20);
    const connection = await this.connection(input.connectionId);
    // Validate a front-channel endpoint with the same outbound destination policy.
    await validateSsoEndpoint(connection.config.idpSsoUrl, this.options.env.OUTBOUND_ALLOW_CIDRS);
    const requestId = `_${random()}`;
    const relayState = random();
    const browserNonce = random();
    const protocol = await this.protocol(connection, requestId);
    const url = await protocol.getAuthorizeUrlAsync(relayState, undefined, {});
    await this.requests.put(relayState, {
      connectionId: input.connectionId,
      configurationHash: configurationHash(connection.row),
      requestId,
      browserNonceHash: ssoHash(browserNonce),
      returnTo: ssoReturnToSchema.parse(input.returnTo),
      ...(input.expectedSubject ? { expectedSubject: input.expectedSubject } : {}),
    });
    return { url, browserNonce };
  }

  private responseEnvelope(xml: string, connectionId: string) {
    const response = samlDocument(xml).documentElement;
    if (
      response.namespaceURI !== SAML_PROTOCOL_NS ||
      response.localName !== 'Response' ||
      response.getAttribute('Destination') !== this.acsUrl(connectionId)
    )
      throw new SamlFailure('sso-response-invalid');
    const status = samlChild(response, SAML_PROTOCOL_NS, 'Status');
    if (
      samlChild(status, SAML_PROTOCOL_NS, 'StatusCode').getAttribute('Value') !==
      'urn:oasis:names:tc:SAML:2.0:status:Success'
    )
      throw new SamlFailure('sso-response-invalid');
    return response;
  }
  private async validatedIdentity(
    connection: Awaited<ReturnType<SamlService['connection']>>,
    body: ReturnType<typeof samlAcsSchema.parse>,
  ) {
    const xml = await samlResponseXml(
      Buffer.from(body.SAMLResponse, 'base64').toString('utf8'),
      (await this.options.sso.spKeys()).privateKey,
    );
    const response = this.responseEnvelope(xml, connection.row.id);
    const validated = await (await this.protocol(connection)).validatePostResponseAsync({
      SAMLResponse: Buffer.from(xml).toString('base64'),
    });
    if (!validated.profile || validated.loggedOut) throw new SamlFailure('sso-assertion-invalid');
    const identity = samlAssertion({
      profile: validated.profile,
      connectionId: connection.row.id,
      issuer: connection.config.idpEntityId,
      recipient: this.acsUrl(connection.row.id),
      emailDomains: connection.row.emailDomains,
      emailAttribute: connection.config.emailAttribute,
      nameAttribute: connection.config.nameAttribute,
      groupAttribute: connection.row.groupAttribute,
      skewSeconds: connection.config.clockSkewSeconds,
      nameIdFormat: samlNameIdFormat(connection.config.nameIdFormat),
    });
    if ((response.getAttribute('InResponseTo') || null) !== identity.requestId)
      throw new SamlFailure('sso-request-invalid');
    return identity;
  }
  async accept(input: { connectionId: string; body: unknown; ip: string }) {
    await this.limit('sso-saml-acs', input.ip, 40);
    const body = samlAcsSchema.parse(input.body);
    const connection = await this.connection(input.connectionId);
    try {
      const identity = await this.validatedIdentity(connection, body);
      await claimSamlResponse(this.options.redis, {
        connectionId: input.connectionId,
        assertionId: identity.assertionId,
        requestId: identity.requestId,
      });
      return await this.acceptedHandoff({ connection, body, identity, ip: input.ip });
    } catch (error) {
      const reason = error instanceof SamlFailure ? error.code : 'sso-assertion-invalid';
      this.options.logger.warn(
        { connectionId: input.connectionId, reason },
        'SAML assertion refused',
      );
      throw new SamlFailure(reason);
    }
  }

  private async acceptedHandoff(input: {
    connection: Awaited<ReturnType<SamlService['connection']>>;
    body: ReturnType<typeof samlAcsSchema.parse>;
    identity: ReturnType<typeof samlAssertion>;
    ip: string;
  }) {
    const { connection, identity, body } = input;
    if (!identity.requestId) {
      if (!connection.config.allowIdpInitiated) throw new SamlFailure('sso-request-invalid');
      // An unsolicited identity must prove the same subject in a browser-bound SP flow.
      return {
        kind: 'challenge' as const,
        ...(await this.start({
          connectionId: connection.row.id,
          returnTo: '/',
          ip: input.ip,
          expectedSubject: identity.assertion.subject,
        })),
      };
    }
    if (!body.RelayState) throw new SamlFailure('sso-request-invalid');
    const token = random();
    await this.pending.put(token, {
      connectionId: connection.row.id,
      configurationHash: configurationHash(connection.row),
      assertion: identity.assertion,
      requestId: identity.requestId,
      relayState: body.RelayState,
    });
    return { kind: 'pending' as const, token };
  }

  async complete(input: {
    connectionId: string;
    token: string;
    browserNonce: string | undefined;
    ip: string;
  }) {
    await this.limit('sso-saml-complete', input.ip, 40);
    const pending = await this.pending.consume(input.token);
    if (!pending || pending.connectionId !== input.connectionId)
      throw new SamlFailure('sso-request-invalid');
    const request = await this.requests.consume(pending.relayState);
    if (
      !request ||
      request.connectionId !== input.connectionId ||
      request.requestId !== pending.requestId ||
      !matchesBrowserNonce(input.browserNonce, request.browserNonceHash)
    )
      throw new SamlFailure('sso-request-invalid');
    const connection = await this.connection(input.connectionId);
    if (
      request.configurationHash !== configurationHash(connection.row) ||
      pending.configurationHash !== request.configurationHash
    )
      throw new SamlFailure('sso-configuration-changed');
    if (request.expectedSubject && request.expectedSubject !== pending.assertion.subject)
      throw new SamlFailure('sso-subject-invalid');
    return { assertion: pending.assertion, returnTo: request.returnTo };
  }

  async metadata(ip: string) {
    await this.limit('sso-saml-metadata', ip, 30);
    const rows = await this.options.db
      .select({ id: ssoConnections.id })
      .from(ssoConnections)
      .where(and(eq(ssoConnections.protocol, 'saml'), eq(ssoConnections.enabled, true)))
      .orderBy(ssoConnections.id);
    const [first] = rows;
    if (!first) throw new SamlFailure('sso-connection-disabled');
    const keys = await this.options.sso.spKeys();
    const xml = generateServiceProviderMetadata({
      issuer: this.entityId(),
      callbackUrl: this.acsUrl(first.id),
      privateKey: keys.privateKey,
      publicCerts: keys.certificate,
      decryptionPvk: keys.privateKey,
      decryptionCert: keys.certificate,
      wantAssertionsSigned: true,
      signatureAlgorithm: 'sha256',
    });
    const document = samlDocument(xml);
    for (const method of Array.from(
      document.getElementsByTagNameNS(SAML_METADATA_NS, 'EncryptionMethod'),
    ))
      if ((method.getAttribute('Algorithm') ?? '').endsWith('-cbc'))
        method.parentNode?.removeChild(method);
    const descriptor = samlChild(document.documentElement, SAML_METADATA_NS, 'SPSSODescriptor');
    const template = samlChild(descriptor, SAML_METADATA_NS, 'AssertionConsumerService');
    rows.slice(1).forEach((row, index) => {
      const acs = template.cloneNode(true);
      if (acs.nodeType !== 1) throw new SamlFailure('sso-xml-invalid');
      const element = acs as typeof template;
      element.setAttribute('index', String(index + 2));
      element.removeAttribute('isDefault');
      element.setAttribute('Location', this.acsUrl(row.id));
      descriptor.appendChild(element);
    });
    return document.toString();
  }
}
