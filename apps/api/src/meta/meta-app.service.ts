import { randomBytes } from 'node:crypto';
import { DEFAULT_META_GRAPH_VERSION } from '@helpdock/channels';
import type { Env, Settings } from '@helpdock/config';
import { SettingLockedError, settingDefinitions } from '@helpdock/config';
import { auditLog, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import {
  META_TOKEN_HINT_LENGTH,
  type MetaApp,
  type MetaVerifyTokenReveal,
  metaWebhookPath,
} from '@helpdock/schemas';
import { ConflictException } from '@nestjs/common';
import { principalIdOf } from '../auth/principal.js';
import { getTx, requireRequestContext } from '../context/request-context.js';

/**
 * The install's one Meta developer app (M10-02, ADR 0025, 5): an app id, an app
 * secret, an Instagram app secret and the token Meta's handshake presents are
 * install settings (`meta.*`), because a Meta app has one callback URL and one
 * signing secret. The connected numbers, Pages and accounts, each with its own
 * token, are `meta_accounts` rows.
 *
 * The secrets are read through the settings resolver, which decrypts them and
 * keeps them in process until a change is announced, so the webhook asks for
 * them on every request without a query.
 */

/** The settings an `HD_META_*` variable can take over, for the App card. */
const APP_SETTING_KEYS = [
  'meta.appId',
  'meta.appSecret',
  'meta.instagramAppSecret',
  'meta.webhookVerifyToken',
] as const;

/** Printable and URL-safe: it travels in a query string. 24 random bytes is 32 characters. */
const newVerifyToken = (): string => randomBytes(24).toString('base64url');

export class MetaAppService {
  readonly #settings: Pick<Settings, 'get' | 'set' | 'isLockedByEnv'>;
  readonly #appUrl: string;
  readonly #graphVersion: string;

  constructor(
    settings: Pick<Settings, 'get' | 'set' | 'isLockedByEnv'>,
    env: Pick<Env, 'APP_URL' | 'META_GRAPH_VERSION'>,
  ) {
    this.#settings = settings;
    this.#appUrl = env.APP_URL;
    this.#graphVersion = env.META_GRAPH_VERSION ?? DEFAULT_META_GRAPH_VERSION;
  }

  /**
   * What a webhook's signature may be made with: the app secret and, when the
   * Instagram product has one, the Instagram app secret. Empty entries are left
   * out, so an install with no app configured answers an empty list and
   * nothing verifies.
   */
  async secrets(): Promise<string[]> {
    const { appSecret, instagramAppSecret } = await this.signingSecrets();
    return [appSecret, instagramAppSecret].filter((secret) => secret !== '');
  }

  /**
   * The two secrets apart, empty when unset, for a webhook to tell which of them
   * signed: the Instagram app secret vouches for Instagram's envelopes only
   * (the webhook's `receive`), and the app secret for all three.
   */
  async signingSecrets(): Promise<{
    readonly appSecret: string;
    readonly instagramAppSecret: string;
  }> {
    const [appSecret, instagramAppSecret] = await Promise.all([
      this.#settings.get('meta.appSecret'),
      this.#settings.get('meta.instagramAppSecret'),
    ]);
    return { appSecret, instagramAppSecret };
  }

  /**
   * The app's id, empty when none is set. Messenger and Instagram put it on the
   * echo of every message the app sent, which is how Helpdock's own are told
   * from the rest (M10-04).
   */
  appId(): Promise<string> {
    return this.#settings.get('meta.appId');
  }

  /**
   * The handshake's token as stored, empty when none was ever made. The public
   * route reads this, never {@link verifyToken}: a stranger's request must not
   * be what writes a setting.
   */
  currentVerifyToken(): Promise<string> {
    return this.#settings.get('meta.webhookVerifyToken');
  }

  /** The token, made and stored on first use so the App card always has one to show. */
  async verifyToken(): Promise<string> {
    const current = await this.currentVerifyToken();
    return current === '' ? this.#store(newVerifyToken()) : current;
  }

  /** A new token for the handshake, shown once; the old one stops working at once. */
  async rotateVerifyToken(): Promise<MetaVerifyTokenReveal> {
    return { verifyToken: await this.#store(newVerifyToken()) };
  }

  /** Where Meta posts webhooks and where its dashboard's callback URL field points. */
  callbackUrl(): string {
    return new URL(metaWebhookPath(), this.#appUrl).toString();
  }

  /**
   * The App card (M10-07 draws it): no secret travels, only whether each is
   * set. The app id is shown as it is, because Meta prints it on every
   * dashboard page and the card exists to be compared with that page.
   */
  async card(): Promise<MetaApp> {
    const [appId, appSecret, instagramAppSecret, verifyToken] = await Promise.all([
      this.#settings.get('meta.appId'),
      this.#settings.get('meta.appSecret'),
      this.#settings.get('meta.instagramAppSecret'),
      this.verifyToken(),
    ]);

    return {
      appIdSet: appId !== '',
      appId,
      appSecretSet: appSecret !== '',
      instagramAppSecretSet: instagramAppSecret !== '',
      graphVersion: this.#graphVersion,
      callbackUrl: this.callbackUrl(),
      verifyTokenHint: verifyToken.slice(-META_TOKEN_HINT_LENGTH),
      secretsLockedByEnv: APP_SETTING_KEYS.filter((key) => this.#settings.isLockedByEnv(key)),
    };
  }

  async #store(token: string): Promise<string> {
    const principal = requireRequestContext().principal;
    if (principal === null) {
      throw new Error('A Meta app route ran without a principal');
    }
    const actorId = principalIdOf(principal);

    try {
      await this.#settings.set('meta.webhookVerifyToken', token, { updatedBy: actorId });
    } catch (error) {
      if (error instanceof SettingLockedError) {
        throw new ConflictException(
          `${settingDefinitions['meta.webhookVerifyToken'].envKey} locks this setting`,
        );
      }
      throw error;
    }
    await getTx()
      .insert(auditLog)
      .values({
        brandId: INSTALL_SCOPE_BRAND_ID,
        actorType: principal.type,
        actorId,
        action: 'settings.updated',
        targetType: 'settings',
        targetId: 'meta',
        // Names only. A replacement is useful evidence; its value never is.
        meta: { keys: ['meta.webhookVerifyToken'] },
      });

    return token;
  }
}
