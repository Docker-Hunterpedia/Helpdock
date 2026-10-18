import {
  type SsoConfiguration,
  type SsoConnection,
  type SsoConnectionInput,
  type SsoMapping,
  type SsoSettings,
  type SsoSettingsUpdate,
  ssoCertificatesSchema,
  ssoConfigurationSchema,
  ssoConnectionCreateSchema,
  ssoConnectionSchema,
  ssoMappingsSchema,
  ssoSettingsUpdateSchema,
} from '@helpdock/schemas';
import { MOCK_BRANDS, MOCK_USER, type MockAuthApi } from '../auth/mock-api.js';
import { MOCK_DEPARTMENTS } from '../staff/mock-api.js';
import { type SsoApi, SsoError } from './api.js';

export class MockSsoApi implements SsoApi {
  readonly #connections = new Map<string, SsoConnection>();
  readonly #mappings = new Map<string, SsoMapping[]>();
  #settings: SsoSettings = {
    enforced: false,
    breakGlassUserIds: [],
    enforcedLocked: false,
    breakGlassLocked: false,
  };
  constructor(private readonly auth?: MockAuthApi) {}

  async inspectCertificates(certificates: string[]) {
    const parsed = ssoCertificatesSchema.parse({ certificates });
    return {
      certificates: await Promise.all(
        parsed.certificates.map(async (pem) => {
          if (!/^-----BEGIN CERTIFICATE-----/.test(pem)) throw new Error('sso-invalid-certificate');
          const encoded = pem.replace(/-----[^-]+-----|\s/g, '');
          const der = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
          return {
            subject: 'Mock identity provider',
            fingerprint: [...digest]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(':')
              .toUpperCase(),
            expiresAt: '2027-10-13T00:00:00Z',
          };
        }),
      ),
    };
  }
  async saveConfiguration(id: string | null, input: SsoConfiguration) {
    const validated = ssoConfigurationSchema.parse(input);
    const connection =
      id === null
        ? await this.create(validated.connection)
        : await this.update(id, validated.connection);
    this.#mappings.set(connection.id, validated.mappings);
    return connection;
  }
  async connections() {
    return {
      connections: [...this.#connections.values()].map((connection) => structuredClone(connection)),
    };
  }
  async connection(id: string) {
    const connection = this.#connection(id);
    const base = 'https://support.helpdock.com';
    return {
      ...structuredClone(connection),
      sp: {
        entityId: `${base}/api/auth/sso/saml/metadata`,
        metadataUrl: `${base}/api/auth/sso/saml/metadata`,
        acsUrl: `${base}/api/auth/sso/${id}/saml/acs`,
        oidcRedirectUri: `${base}/api/auth/sso/${id}/oidc/callback`,
      },
    };
  }
  async create(input: SsoConnectionInput) {
    const validated = ssoConnectionCreateSchema.parse(input);
    this.#checkDomains(validated);
    const connection = ssoConnectionSchema.parse({
      ...validated,
      id: crypto.randomUUID(),
      protocol: validated.config.protocol,
      secretConfigured: validated.clientSecret !== undefined,
      lastSignInAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.#connections.set(connection.id, connection);
    this.#syncAuth();
    return structuredClone(connection);
  }
  async update(id: string, input: SsoConnectionInput) {
    const current = this.#connection(id);
    const validated = ssoConnectionCreateSchema.parse(input);
    if (current.protocol !== validated.config.protocol) throw new Error('sso-protocol-immutable');
    this.#checkDomains(validated, id);
    if (
      current.enabled &&
      !validated.enabled &&
      this.#settings.enforced &&
      [...this.#connections.values()].filter((connection) => connection.enabled).length === 1
    )
      throw new Error('sso-enforced-last');
    const updated = ssoConnectionSchema.parse({
      ...current,
      ...validated,
      secretConfigured: current.secretConfigured || validated.clientSecret !== undefined,
      updatedAt: new Date().toISOString(),
    });
    this.#connections.set(id, updated);
    this.#syncAuth();
    return structuredClone(updated);
  }
  async remove(id: string) {
    const connection = this.#connection(id);
    if (
      this.#settings.enforced &&
      connection.enabled &&
      [...this.#connections.values()].filter((row) => row.enabled).length === 1
    )
      throw new Error('sso-enforced-last');
    this.#connections.delete(id);
    this.#mappings.delete(id);
    this.#syncAuth();
  }
  async mappings(id: string) {
    this.#connection(id);
    return { mappings: structuredClone(this.#mappings.get(id) ?? []) };
  }
  async saveMappings(id: string, mappings: SsoMapping[]) {
    this.#connection(id);
    this.#mappings.set(id, ssoMappingsSchema.parse({ mappings }).mappings);
    return this.mappings(id);
  }
  async settings() {
    return structuredClone(this.#settings);
  }
  async saveSettings(input: SsoSettingsUpdate) {
    const validated = ssoSettingsUpdateSchema.parse(input);
    if (
      validated.enforced &&
      ![...this.#connections.values()].some((connection) => connection.enabled)
    )
      throw new Error('sso-enforced-no-connection');
    if (validated.breakGlassUserIds.some((id) => id !== MOCK_USER.id))
      throw new Error('sso-break-glass-needs-totp');
    this.#settings = { ...this.#settings, ...validated };
    this.#syncAuth();
    return this.settings();
  }
  async targets() {
    return {
      sp: {
        entityId: 'https://support.helpdock.com/api/auth/sso/saml/metadata',
        metadataUrl: 'https://support.helpdock.com/api/auth/sso/saml/metadata',
      },
      brands: MOCK_BRANDS.map((brand) => ({
        id: brand.id,
        name: brand.name,
        departments: [...MOCK_DEPARTMENTS],
      })),
      admins: [{ id: MOCK_USER.id, name: MOCK_USER.name, email: MOCK_USER.email, eligible: true }],
    };
  }
  async test(id: string) {
    this.#connection(id);
    return {
      startUrl: new URL(
        `/admin/settings/sso/${id}?test=${'m'.repeat(43)}`,
        window.location.origin,
      ).toString(),
    };
  }
  async testResult(id: string, _key: string) {
    const connection = this.#connection(id);
    return {
      claims: {
        subject: 'mock-staff',
        email: MOCK_USER.email,
        name: MOCK_USER.name,
        groups: ['support'],
      },
      user: { id: MOCK_USER.id, email: MOCK_USER.email, name: MOCK_USER.name },
      wouldCreate: false,
      conflict: false,
      access: connection.defaultAccess ? [connection.defaultAccess] : [],
    };
  }
  /** The api's rule: two enabled connections never list the same email domain. */
  #checkDomains(input: SsoConnectionInput, id?: string) {
    if (!input.enabled) return;
    const listed = new Set(
      [...this.#connections.values()]
        .filter((connection) => connection.enabled && connection.id !== id)
        .flatMap((connection) => connection.emailDomains),
    );
    const taken = input.emailDomains.filter((domain) => listed.has(domain));
    if (taken.length > 0) throw new SsoError('sso-email-domain-taken', taken);
  }
  #connection(id: string): SsoConnection {
    const connection = this.#connections.get(id);
    if (!connection) throw new Error('sso-connection-not-found');
    return connection;
  }
  #syncAuth() {
    if (this.auth) {
      this.auth.ssoEnforced = this.#settings.enforced;
      this.auth.ssoConnections = [...this.#connections.values()]
        .filter((connection) => connection.enabled)
        .map(({ id, name, emailDomains }) => ({ id, name, emailDomains }));
    }
  }
}
