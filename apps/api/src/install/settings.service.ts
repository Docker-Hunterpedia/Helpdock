import type { Env, Settings } from '@helpdock/config';
import { SettingLockedError, settingDefinitions } from '@helpdock/config';
import { auditLog, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import type {
  InstallAuthenticationSettings,
  InstallAuthenticationSettingsUpdate,
  OauthProvider,
} from '@helpdock/schemas';
import { ConflictException } from '@nestjs/common';
import { oauthRedirectUri } from '../auth/oauth/providers.js';
import { principalIdOf } from '../auth/principal.js';
import { getTx, requireRequestContext } from '../context/request-context.js';

type EditableAuthenticationKey =
  | 'auth.require2fa'
  | 'auth.magicLinkTtlMinutes'
  | 'oauth.google.clientId'
  | 'oauth.google.clientSecret'
  | 'oauth.google.allowedDomains'
  | 'oauth.microsoft.tenantId'
  | 'oauth.microsoft.allowConsumers'
  | 'oauth.microsoft.clientId'
  | 'oauth.microsoft.clientSecret'
  | 'oauth.github.clientId'
  | 'oauth.github.clientSecret';

type SettingValue = boolean | number | string | readonly string[];

/** A list compares by its members in order; everything else by value. */
const sameValue = (a: SettingValue | undefined, b: SettingValue): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, index) => item === b[index])
    : a === b;

/** The M0-02 Authentication view of the install-wide Settings screen. */
export class InstallSettingsService {
  readonly #settings: Settings;
  readonly #appUrl: string;

  constructor(settings: Settings, env: Pick<Env, 'APP_URL'>) {
    this.#settings = settings;
    this.#appUrl = env.APP_URL;
  }

  async authentication(): Promise<InstallAuthenticationSettings> {
    const [
      requireTwoFactor,
      magicLinkValidityMinutes,
      google,
      allowedDomains,
      microsoft,
      tenantId,
      allowConsumers,
      github,
    ] = await Promise.all([
      this.#settings.get('auth.require2fa'),
      this.#settings.get('auth.magicLinkTtlMinutes'),
      this.#oauth('google'),
      this.#settings.get('oauth.google.allowedDomains'),
      this.#oauth('microsoft'),
      this.#settings.get('oauth.microsoft.tenantId'),
      this.#settings.get('oauth.microsoft.allowConsumers'),
      this.#oauth('github'),
    ]);

    return {
      requireTwoFactor,
      requireTwoFactorLocked: this.#settings.isLockedByEnv('auth.require2fa'),
      magicLinkValidityMinutes,
      magicLinkValidityLocked: this.#settings.isLockedByEnv('auth.magicLinkTtlMinutes'),
      google: {
        ...google,
        allowedDomains: [...allowedDomains],
        allowedDomainsLocked: this.#settings.isLockedByEnv('oauth.google.allowedDomains'),
      },
      microsoft: {
        ...microsoft,
        tenantId,
        tenantIdLocked: this.#settings.isLockedByEnv('oauth.microsoft.tenantId'),
        allowConsumers,
        allowConsumersLocked: this.#settings.isLockedByEnv('oauth.microsoft.allowConsumers'),
        // Off without a tenant, whatever else is set.
        enabled: microsoft.enabled && tenantId !== '',
      },
      github,
      redirectUrls: {
        google: oauthRedirectUri(this.#appUrl, 'google'),
        microsoft: oauthRedirectUri(this.#appUrl, 'microsoft'),
        github: oauthRedirectUri(this.#appUrl, 'github'),
      },
    };
  }

  async saveAuthentication(
    body: InstallAuthenticationSettingsUpdate,
  ): Promise<InstallAuthenticationSettings> {
    const context = requireRequestContext();
    const principal = context.principal;
    if (principal === null) {
      throw new Error('An install settings route ran without a principal');
    }
    const actorId = principalIdOf(principal);
    const before = await this.authentication();
    const changes: Array<readonly [EditableAuthenticationKey, SettingValue]> = [
      ['auth.require2fa', body.requireTwoFactor],
      ['auth.magicLinkTtlMinutes', body.magicLinkValidityMinutes],
      ['oauth.google.clientId', body.google.clientId],
      ['oauth.microsoft.tenantId', body.microsoft.tenantId],
      ['oauth.microsoft.clientId', body.microsoft.clientId],
      ...(body.microsoft.allowConsumers === undefined
        ? []
        : ([['oauth.microsoft.allowConsumers', body.microsoft.allowConsumers]] as const)),
      ['oauth.github.clientId', body.github.clientId],
      ...(body.google.clientSecret === undefined
        ? []
        : ([['oauth.google.clientSecret', body.google.clientSecret]] as const)),
      ...(body.microsoft.clientSecret === undefined
        ? []
        : ([['oauth.microsoft.clientSecret', body.microsoft.clientSecret]] as const)),
      ...(body.github.clientSecret === undefined
        ? []
        : ([['oauth.github.clientSecret', body.github.clientSecret]] as const)),
      ...(body.google.allowedDomains === undefined
        ? []
        : ([['oauth.google.allowedDomains', body.google.allowedDomains]] as const)),
    ];
    const current = new Map<EditableAuthenticationKey, SettingValue>([
      ['auth.require2fa', before.requireTwoFactor],
      ['auth.magicLinkTtlMinutes', before.magicLinkValidityMinutes],
      ['oauth.google.clientId', before.google.clientId],
      ['oauth.microsoft.tenantId', before.microsoft.tenantId],
      ['oauth.microsoft.clientId', before.microsoft.clientId],
      ['oauth.microsoft.allowConsumers', before.microsoft.allowConsumers],
      ['oauth.github.clientId', before.github.clientId],
      ['oauth.google.allowedDomains', before.google.allowedDomains],
    ]);
    const changed = changes.filter(([key, value]) => !sameValue(current.get(key), value));

    for (const [key] of changed) {
      if (this.#settings.isLockedByEnv(key)) {
        throw new ConflictException(`${settingDefinitions[key].envKey} locks this setting`);
      }
    }

    try {
      for (const [key, value] of changed) {
        await this.#set(key, value, actorId);
      }
    } catch (error) {
      if (error instanceof SettingLockedError) {
        throw new ConflictException(`${error.envKey} locks this setting`);
      }
      throw error;
    }

    if (changed.length > 0) {
      await getTx()
        .insert(auditLog)
        .values({
          brandId: INSTALL_SCOPE_BRAND_ID,
          actorType: principal.type,
          actorId,
          action: 'settings.updated',
          targetType: 'settings',
          targetId: 'authentication',
          // Names only. A replacement is useful evidence; its value never is.
          meta: { keys: changed.map(([key]) => key) },
        });
    }

    return this.authentication();
  }

  async #oauth(provider: OauthProvider) {
    const clientIdKey = `oauth.${provider}.clientId` as const;
    const clientSecretKey = `oauth.${provider}.clientSecret` as const;
    const [clientId, clientSecret] = await Promise.all([
      this.#settings.get(clientIdKey),
      this.#settings.get(clientSecretKey),
    ]);

    return {
      clientId,
      clientIdLocked: this.#settings.isLockedByEnv(clientIdKey),
      clientSecretConfigured: clientSecret !== '',
      clientSecretLocked: this.#settings.isLockedByEnv(clientSecretKey),
      enabled: clientId !== '' && clientSecret !== '',
    };
  }

  #set(key: EditableAuthenticationKey, value: SettingValue, actorId: string) {
    // The pair is narrowed by the private caller from this closed key set. Each
    // value has already crossed the request schema and is checked again by the
    // setting registry before it is stored.
    return this.#settings.set(key, value as never, { updatedBy: actorId });
  }
}
