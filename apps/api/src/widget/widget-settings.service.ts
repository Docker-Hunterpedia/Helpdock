import { encryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, type DbTransaction } from '@helpdock/db';
import type {
  ContentPolicy,
  SecretStamp,
  WidgetAccessUpdate,
  WidgetAppearance,
  WidgetConversationSettings,
  WidgetSettings,
  WidgetSignedIdentity,
  WidgetSigningSecret,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { readContentPolicy } from '../media/content-policy.js';
import { resolveCaptcha, resolveWidgetSettings } from './resolved-settings.js';
import { issueSigningSecret } from './visitor-credential.js';
import { CAPTCHA_KEYS, type WidgetSettingsRepository } from './widget-settings.repository.js';

/**
 * Channels › Widget (artboard `AdminWidget`; M4-03, M4-06, M4-07, M4-08).
 *
 * Five saves, one per card, so what a person may change is decided by the
 * route rather than by which fields a body happens to carry: a Team Leader's
 * appearance, conversation and content-policy saves have no origin, CAPTCHA
 * or signing field in them to smuggle.
 *
 * **Secrets** (DOMAIN-RULES §4.2, ADR 0003) are encrypted under
 * `APP_MASTER_KEY` before they are written, never returned after, and
 * recorded in the audit log as "changed" — never their value.
 */

export interface WidgetAdminContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
  /** An Admin sees and saves the two Admin-only cards; a Team Leader does not. */
  readonly isAdmin: boolean;
  readonly now: Date;
}

type WidgetAuditAction =
  | 'widget.appearance_updated'
  | 'widget.conversation_updated'
  | 'widget.content_policy_updated'
  | 'widget.access_updated'
  | 'widget.signed_identity_updated'
  | 'widget.signing_secret_replaced';

export class WidgetSettingsService {
  readonly #repository: WidgetSettingsRepository;
  readonly #keyring: Keyring;

  constructor(repository: WidgetSettingsRepository, keyring: Keyring) {
    this.#repository = repository;
    this.#keyring = keyring;
  }

  async view(context: WidgetAdminContext): Promise<WidgetSettings> {
    const { tx, brandId } = context;
    const brand = await this.#repository.brand(tx, brandId);
    /* c8 ignore next 3 -- the permission guard already resolved the brand. */
    if (brand === undefined) {
      throw new NotFoundException('No such brand');
    }
    const settings = resolveWidgetSettings(await this.#repository.row(tx, brandId));

    if (!context.isAdmin) {
      return {
        brandId,
        appearance: settings.appearance,
        conversation: settings.conversation,
        contentPolicy: readContentPolicy(brand.contentPolicy),
        access: null,
        signedIdentity: null,
        updatedAt: (settings.updatedAt ?? context.now).toISOString(),
      };
    }

    const captcha = resolveCaptcha(await this.#repository.captcha(tx, brandId));

    return {
      brandId,
      appearance: settings.appearance,
      conversation: settings.conversation,
      contentPolicy: readContentPolicy(brand.contentPolicy),
      access: {
        allowedOrigins: [...settings.allowedOrigins],
        captchaEnabled: settings.captchaEnabled,
        captchaProvider: captcha.provider,
        captchaSiteKey: captcha.siteKey,
        captchaSecret: await this.#stamp(tx, captcha.secretSetAt, captcha.secretSetBy),
      },
      signedIdentity: {
        enabled: settings.signedIdentityEnabled,
        seesAllChannels: settings.signedIdentitySeesAllChannels,
        secret:
          settings.signingSecret === null
            ? null
            : await this.#stamp(tx, settings.signingSecretSetAt, settings.signingSecretSetBy),
      },
      updatedAt: (settings.updatedAt ?? context.now).toISOString(),
    };
  }

  async saveAppearance(
    context: WidgetAdminContext,
    appearance: WidgetAppearance,
  ): Promise<WidgetSettings> {
    await this.#repository.upsert(context.tx, context.brandId, { appearance });
    await this.#audit(context, 'widget.appearance_updated', { ...appearance });
    return this.view(context);
  }

  async saveConversation(
    context: WidgetAdminContext,
    conversation: WidgetConversationSettings,
  ): Promise<WidgetSettings> {
    await this.#repository.upsert(context.tx, context.brandId, { conversation });
    await this.#audit(context, 'widget.conversation_updated', { ...conversation });
    return this.view(context);
  }

  /** M4-07: the same `brands.settings.contentPolicy` the media pipeline enforces. */
  async saveContentPolicy(
    context: WidgetAdminContext,
    policy: ContentPolicy,
  ): Promise<WidgetSettings> {
    await this.#repository.writeContentPolicy(context.tx, context.brandId, policy);
    await this.#audit(context, 'widget.content_policy_updated', { ...policy });
    return this.view(context);
  }

  async saveAccess(
    context: WidgetAdminContext,
    access: WidgetAccessUpdate,
  ): Promise<WidgetSettings> {
    const { tx, brandId, actorId } = context;
    await this.#repository.upsert(tx, brandId, {
      allowedOrigins: [...new Set(access.allowedOrigins)],
      captchaEnabled: access.captchaEnabled,
    });
    await this.#repository.writeSetting(
      tx,
      brandId,
      CAPTCHA_KEYS.provider,
      JSON.stringify(access.captchaProvider),
      actorId,
    );
    await this.#repository.writeSetting(
      tx,
      brandId,
      CAPTCHA_KEYS.siteKey,
      JSON.stringify(access.captchaSiteKey),
      actorId,
    );
    const secretChanged = access.captchaSecret !== undefined && access.captchaSecret !== '';
    if (secretChanged) {
      await this.#repository.writeSetting(
        tx,
        brandId,
        CAPTCHA_KEYS.secret,
        encryptSecret(JSON.stringify(access.captchaSecret), this.#keyring),
        actorId,
      );
    }

    await this.#audit(context, 'widget.access_updated', {
      allowedOrigins: access.allowedOrigins,
      captchaEnabled: access.captchaEnabled,
      captchaProvider: access.captchaProvider,
      captchaSiteKey: access.captchaSiteKey,
      captchaSecret: secretChanged ? 'changed' : 'unchanged',
    });
    return this.view(context);
  }

  async saveSignedIdentity(
    context: WidgetAdminContext,
    signed: WidgetSignedIdentity,
  ): Promise<WidgetSettings> {
    await this.#repository.upsert(context.tx, context.brandId, {
      signedIdentityEnabled: signed.enabled,
      signedIdentitySeesAllChannels: signed.seesAllChannels,
    });
    await this.#audit(context, 'widget.signed_identity_updated', { ...signed });
    return this.view(context);
  }

  /**
   * A new signing secret, returned this once (artboard: "It will not be shown
   * again"). The old one stops verifying at the moment this commits.
   */
  async replaceSigningSecret(context: WidgetAdminContext): Promise<WidgetSigningSecret> {
    const { tx, brandId, actorId, now } = context;
    const secret = issueSigningSecret();
    await this.#repository.upsert(tx, brandId, {
      signingSecret: encryptSecret(secret, this.#keyring),
      signingSecretSetAt: now,
      signingSecretSetBy: actorId,
    });
    await this.#audit(context, 'widget.signing_secret_replaced', { secret: 'changed' });

    return {
      secret,
      stamp: { setAt: now.toISOString(), setBy: await this.#repository.userName(tx, actorId) },
    };
  }

  async #stamp(tx: DbTransaction, at: Date | null, by: string | null): Promise<SecretStamp | null> {
    return at === null
      ? null
      : { setAt: at.toISOString(), setBy: await this.#repository.userName(tx, by) };
  }

  async #audit(
    context: WidgetAdminContext,
    action: WidgetAuditAction,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await context.tx.insert(auditLog).values({
      brandId: context.brandId,
      actorType: 'staff',
      actorId: context.actorId,
      action,
      targetType: 'widget',
      targetId: context.brandId,
      meta,
    });
  }
}
