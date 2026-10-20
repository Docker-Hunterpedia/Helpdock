import { type Env, encryptSecret, type Keyring, type Settings } from '@helpdock/config';
import {
  auditLog,
  brands,
  type Db,
  type DbTransaction,
  departments,
  INSTALL_SCOPE_BRAND_ID,
  ssoConnections,
  ssoRoleMappings,
  userSsoIdentities,
  users,
  withSystem,
} from '@helpdock/db';
import { addressInCidrs, resolvePublicHost, SafeFetchError } from '@helpdock/net';
import {
  type SsoConnectionInput,
  type SsoMapping,
  type SsoSettingsUpdate,
  ssoConnectionSchema,
} from '@helpdock/schemas';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AuthFailure } from '../auth/auth-failure.js';
import { principalIdOf } from '../auth/principal.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { isBreakGlassEligible, passkeyCounts, passkeyHoldings } from './break-glass.js';
import { ssoIdentityAuthority } from './identity-authority.js';
import { addsCertificates, fetchSamlMetadata, samlCertificate } from './saml-metadata.js';
import { loadSpKeys, SSO_CONFIG_LOCK } from './sp-keys.js';
import { SsoFailure } from './sso-failure.js';
import { readSsoSetting, writeSsoSetting } from './sso-settings.js';

export interface SsoServiceOptions {
  readonly db: Db;
  readonly redis: Redis;
  readonly settings: Settings;
  readonly keyring: Keyring;
  readonly env: Pick<Env, 'APP_URL' | 'OUTBOUND_ALLOW_CIDRS'>;
}

const view = (row: typeof ssoConnections.$inferSelect) =>
  ssoConnectionSchema.parse({
    ...row,
    secretConfigured: row.secretEncrypted !== null,
    lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

export class SsoService {
  constructor(private readonly options: SsoServiceOptions) {}

  inspectCertificates(certificates: string[]) {
    try {
      return {
        certificates: certificates.map((pem) => {
          const certificate = samlCertificate(pem);
          return {
            subject: certificate.subject,
            fingerprint: certificate.fingerprint256,
            expiresAt: new Date(certificate.validTo).toISOString(),
          };
        }),
      };
    } catch {
      // Parsing untrusted PEM is a validation boundary; never expose OpenSSL errors.
      throw new BadRequestException('sso-invalid-certificate');
    }
  }

  async signInProtocol(id: string): Promise<'oidc' | 'saml'> {
    // Explicit pre-tenant read of install-global configuration for protocol dispatch.
    const [connection] = await this.options.db
      .select({ protocol: ssoConnections.protocol, enabled: ssoConnections.enabled })
      .from(ssoConnections)
      .where(eq(ssoConnections.id, id));
    if (!connection?.enabled) throw new AuthFailure('sso-connection-disabled');
    return connection.protocol;
  }

  async list() {
    const rows = await getTx()
      .select({
        connection: ssoConnections,
        peopleCount: sql<number>`(select count(*)::int from ${userSsoIdentities} where ${userSsoIdentities.connectionId} = ${ssoConnections.id})`,
      })
      .from(ssoConnections)
      .orderBy(ssoConnections.name);
    return {
      connections: rows.map(({ connection, peopleCount }) => ({
        ...view(connection),
        peopleCount,
      })),
    };
  }

  async get(id: string) {
    const connection = view(await this.row(id));
    const [linked] = await getTx()
      .select({ count: sql<number>`count(*)::int` })
      .from(userSsoIdentities)
      .where(eq(userSsoIdentities.connectionId, id));
    connection.peopleCount = linked?.count ?? 0;
    const base = this.options.env.APP_URL;
    const url = (path: string) => new URL(path, base).toString();
    return {
      ...connection,
      sp: {
        entityId: url('/api/auth/sso/saml/metadata'),
        metadataUrl: url('/api/auth/sso/saml/metadata'),
        acsUrl: url(`/api/auth/sso/${id}/saml/acs`),
        oidcRedirectUri: url(`/api/auth/sso/${id}/oidc/callback`),
      },
    };
  }

  async create(input: SsoConnectionInput) {
    await this.validate(input);
    const tx = getTx();
    await this.lock(tx);
    const actor = this.actor();
    await this.checkName(input.name);
    await this.checkDomains(input);
    const [created] = await tx
      .insert(ssoConnections)
      .values({
        ...this.values(input),
        createdBy: actor,
      })
      .returning();
    if (created === undefined) throw new Error('SSO connection insert returned no row');
    await this.audit('sso.connection.created', created.id, Object.keys(input));
    return view(created);
  }

  async update(id: string, input: SsoConnectionInput) {
    await this.validate(input);
    const tx = getTx();
    await this.lock(tx);
    const current = await this.row(id);
    await this.checkName(input.name, id);
    await this.checkDomains(input, id);
    const [identity] = await tx
      .select({ id: userSsoIdentities.id })
      .from(userSsoIdentities)
      .where(eq(userSsoIdentities.connectionId, id))
      .limit(1);
    if (
      identity !== undefined &&
      ssoIdentityAuthority(current.config) !== ssoIdentityAuthority(input.config)
    ) {
      throw new ConflictException('sso-identity-configuration-in-use');
    }
    if (current.protocol !== input.config.protocol)
      throw new ConflictException('sso-protocol-immutable');
    if (current.enabled && !input.enabled) await this.canRemoveEnabled(id);
    const [updated] = await tx
      .update(ssoConnections)
      .set(this.values(input))
      .where(eq(ssoConnections.id, id))
      .returning();
    if (updated === undefined) throw new NotFoundException('sso-connection-not-found');
    await this.audit('sso.connection.updated', id, Object.keys(input));
    if (current.enabled !== input.enabled)
      await this.audit(input.enabled ? 'sso.connection.enabled' : 'sso.connection.disabled', id, [
        'enabled',
      ]);
    return view(updated);
  }

  async remove(id: string): Promise<void> {
    await this.lock(getTx());
    const current = await this.row(id);
    if (current.enabled) await this.canRemoveEnabled(id);
    const [identity] = await getTx()
      .select({ id: userSsoIdentities.id })
      .from(userSsoIdentities)
      .where(eq(userSsoIdentities.connectionId, id))
      .limit(1);
    if (identity !== undefined) throw new ConflictException('sso-connection-in-use');
    await getTx().delete(ssoConnections).where(eq(ssoConnections.id, id));
    await this.audit('sso.connection.deleted', id, []);
  }

  async mappings(id: string) {
    await this.row(id);
    return {
      mappings: await getTx()
        .select({
          idpGroup: ssoRoleMappings.idpGroup,
          brandId: ssoRoleMappings.brandId,
          role: ssoRoleMappings.role,
          departmentIds: ssoRoleMappings.departmentIds,
          position: ssoRoleMappings.position,
        })
        .from(ssoRoleMappings)
        .where(eq(ssoRoleMappings.connectionId, id))
        .orderBy(ssoRoleMappings.position),
    };
  }

  async replaceMappings(id: string, mappings: SsoMapping[]) {
    await this.lock(getTx());
    await this.row(id);
    const keys = mappings.map((mapping) => `${mapping.idpGroup}:${mapping.brandId}`);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('sso-duplicate-mapping');
    for (const mapping of mappings) await this.validateAccess(mapping);
    await getTx().delete(ssoRoleMappings).where(eq(ssoRoleMappings.connectionId, id));
    if (mappings.length > 0)
      await getTx()
        .insert(ssoRoleMappings)
        .values(mappings.map((mapping) => ({ ...mapping, connectionId: id })));
    await this.audit('sso.connection.updated', id, ['mappings']);
    return this.mappings(id);
  }

  async targets() {
    const brandRows = await this.options.db
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.status, 'active'));
    const targets = [];
    for (const brand of brandRows) {
      const ownedDepartments = await withSystem(this.options.db, brand.id, (tx) =>
        tx
          .select({ id: departments.id, name: departments.name })
          .from(departments)
          .where(eq(departments.brandId, brand.id)),
      );
      targets.push({ ...brand, departments: ownedDepartments });
    }
    const adminRows = await this.options.db
      .select()
      .from(users)
      .where(and(eq(users.installAdmin, true), eq(users.status, 'active')));
    const held = await passkeyHoldings(
      this.options.db,
      adminRows.map((user) => user.id),
    );
    return {
      sp: {
        entityId: new URL('/api/auth/sso/saml/metadata', this.options.env.APP_URL).toString(),
        metadataUrl: new URL('/api/auth/sso/saml/metadata', this.options.env.APP_URL).toString(),
      },
      brands: targets,
      admins: adminRows.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        eligible: isBreakGlassEligible(user, held.get(user.id)?.verified ?? 0),
        // Only keys that never gave user verification stand between this admin and eligibility.
        passkeyNeedsVerification:
          !isBreakGlassEligible(user, held.get(user.id)?.verified ?? 0) &&
          (held.get(user.id)?.unverified ?? 0) > 0,
      })),
    };
  }

  async settings() {
    const { settings, keyring } = this.options;
    return {
      enforced: await readSsoSetting(getTx(), settings, keyring, 'sso.enforced'),
      breakGlassUserIds: await readSsoSetting(getTx(), settings, keyring, 'sso.breakGlassUserIds'),
      enforcedLocked: settings.isLockedByEnv('sso.enforced'),
      breakGlassLocked: settings.isLockedByEnv('sso.breakGlassUserIds'),
    };
  }

  async saveSettings(input: SsoSettingsUpdate) {
    const tx = getTx();
    await this.lock(tx);
    const before = await this.settings();
    if (
      (before.enforcedLocked && before.enforced !== input.enforced) ||
      (before.breakGlassLocked &&
        JSON.stringify(before.breakGlassUserIds) !== JSON.stringify(input.breakGlassUserIds))
    ) {
      throw new ConflictException('sso-settings-locked');
    }
    await this.validateBreakGlass(input.breakGlassUserIds);
    if (
      input.enforced &&
      (
        await tx
          .select({ id: ssoConnections.id })
          .from(ssoConnections)
          .where(eq(ssoConnections.enabled, true))
          .limit(1)
      ).length === 0
    ) {
      throw new ConflictException('sso-no-enabled-connection');
    }
    if (!before.enforcedLocked)
      await writeSsoSetting(tx, this.options.keyring, {
        key: 'sso.enforced',
        value: input.enforced,
        actorId: this.actor(),
      });
    if (!before.breakGlassLocked)
      await writeSsoSetting(tx, this.options.keyring, {
        key: 'sso.breakGlassUserIds',
        value: input.breakGlassUserIds,
        actorId: this.actor(),
      });
    await this.audit('sso.settings.updated', 'sso', ['enforced', 'breakGlassUserIds']);
    return this.settings();
  }

  spKeys() {
    return loadSpKeys(this.options);
  }

  private async row(id: string) {
    const [row] = await getTx().select().from(ssoConnections).where(eq(ssoConnections.id, id));
    if (row === undefined) throw new NotFoundException('sso-connection-not-found');
    return row;
  }

  private async checkName(name: string, id?: string) {
    const [existing] = await getTx()
      .select({ id: ssoConnections.id })
      .from(ssoConnections)
      .where(sql`lower(${ssoConnections.name}) = lower(${name})`);
    if (existing !== undefined && existing.id !== id) throw new ConflictException('sso-name-taken');
  }

  /**
   * Discovery and email linking pick a connection by domain, so two enabled
   * connections listing one domain would let either IdP speak for its people.
   * Runs under the configuration lock, so concurrent saves cannot both pass.
   */
  private async checkDomains(input: SsoConnectionInput, id?: string) {
    if (!input.enabled) return;
    const others = await getTx()
      .select({ emailDomains: ssoConnections.emailDomains })
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.enabled, true),
          id === undefined ? undefined : ne(ssoConnections.id, id),
        ),
      );
    const listed = new Set(
      others.flatMap((row) => row.emailDomains.map((domain) => domain.toLowerCase())),
    );
    const taken = input.emailDomains.filter((domain) => listed.has(domain));
    if (taken.length > 0) throw new SsoFailure('sso-email-domain-taken', taken);
  }

  private values(input: SsoConnectionInput) {
    const { clientSecret, ...publicFields } = input;
    return {
      ...publicFields,
      protocol: input.config.protocol,
      ...(clientSecret === undefined
        ? {}
        : { secretEncrypted: encryptSecret(clientSecret, this.options.keyring) }),
    };
  }

  private async validate(input: SsoConnectionInput): Promise<void> {
    const config = input.config;
    const urls =
      config.protocol === 'oidc'
        ? [config.issuer]
        : [
            config.idpSsoUrl,
            ...(config.idpMetadataUrl === undefined ? [] : [config.idpMetadataUrl]),
          ];
    for (const raw of urls) {
      const url = new URL(raw);
      try {
        const host = await resolvePublicHost(url.hostname, {
          allowCidrs: this.options.env.OUTBOUND_ALLOW_CIDRS,
        });
        if (
          url.protocol !== 'https:' &&
          !addressInCidrs(host.address, this.options.env.OUTBOUND_ALLOW_CIDRS)
        ) {
          throw new BadRequestException('sso-https-required');
        }
      } catch (error) {
        if (error instanceof SafeFetchError) throw new BadRequestException('sso-endpoint-refused');
        throw error;
      }
    }
    if (config.protocol === 'saml')
      for (const pem of config.idpCertificates) {
        try {
          samlCertificate(pem);
        } catch {
          throw new BadRequestException('sso-invalid-certificate');
        }
      }
    if (config.protocol === 'saml' && config.idpMetadataUrl) {
      let certificates: string[];
      try {
        certificates = await fetchSamlMetadata(config, this.options.env.OUTBOUND_ALLOW_CIDRS);
      } catch {
        throw new BadRequestException('sso-metadata-refused');
      }
      // Saving is the admin's confirmation, so it covers only certificates the
      // admin submitted; metadata may still drop ones it no longer lists.
      if (addsCertificates(config.idpCertificates, certificates))
        throw new SsoFailure('sso-metadata-confirm-certificates');
      config.idpCertificates = certificates;
    }
    if (input.defaultAccess !== null) await this.validateAccess(input.defaultAccess);
  }

  private async validateAccess(
    access: SsoMapping | NonNullable<SsoConnectionInput['defaultAccess']>,
  ): Promise<void> {
    // Explicit install-admin system read: mapping targets may be outside the actor's own brand memberships.
    await withSystem(this.options.db, access.brandId, async (tx) => {
      const [brand] = await tx
        .select({ id: brands.id })
        .from(brands)
        .where(and(eq(brands.id, access.brandId), eq(brands.status, 'active')));
      if (brand === undefined) throw new BadRequestException('sso-invalid-brand');
      const ids = [...new Set(access.departmentIds ?? [])];
      if (ids.length === 0) return;
      const found = await tx
        .select({ id: departments.id })
        .from(departments)
        .where(inArray(departments.id, ids));
      if (found.length !== ids.length) throw new BadRequestException('sso-invalid-department');
    });
  }

  private async validateBreakGlass(ids: string[]): Promise<void> {
    const tx = getTx();
    const found =
      ids.length === 0 ? [] : await tx.select().from(users).where(inArray(users.id, ids));
    const held = await passkeyCounts(tx, ids);
    if (
      found.length !== ids.length ||
      found.some((user) => !isBreakGlassEligible(user, held.get(user.id) ?? 0))
    ) {
      throw new BadRequestException('sso-invalid-break-glass');
    }
  }

  private async canRemoveEnabled(id: string) {
    if (!(await this.settings()).enforced) return;
    const remaining = await getTx()
      .select({ id: ssoConnections.id })
      .from(ssoConnections)
      .where(and(eq(ssoConnections.enabled, true), sql`${ssoConnections.id} <> ${id}`))
      .limit(1);
    if (remaining.length === 0) throw new ConflictException('sso-enforced-last');
  }

  private lock(tx: DbTransaction) {
    return tx.execute(sql`select pg_advisory_xact_lock(${SSO_CONFIG_LOCK})`);
  }

  private actor(): string {
    const principal = requireRequestContext().principal;
    if (principal === null || principal.type !== 'staff' || !principal.installAdmin) {
      throw new Error('SSO configuration requires an install-admin principal');
    }
    return principalIdOf(principal);
  }

  private async audit(action: string, targetId: string, keys: string[]) {
    await getTx().insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId: this.actor(),
      action,
      targetType: 'sso',
      targetId,
      meta: { keys },
    });
  }
}
