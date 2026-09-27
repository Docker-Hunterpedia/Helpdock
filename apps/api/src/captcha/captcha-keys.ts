import {
  type CaptchaProvider as CaptchaAdapter,
  type CaptchaTransport,
  createCaptchaProvider,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { Db, DbTransaction } from '@helpdock/db';
import { policies, safeFetch } from '@helpdock/net';
import type { CaptchaProvider } from '@helpdock/schemas';
import { z } from 'zod';
import { withSystemJob } from '../tenant/system-job.js';
import { resolveCaptcha } from '../widget/resolved-settings.js';
import { WidgetSettingsRepository } from '../widget/widget-settings.repository.js';

/**
 * A brand's CAPTCHA keys (ADR 0003), read-only, for the two visitor-facing
 * surfaces that ask for a challenge: the widget before a first message
 * (M4-03) and the hosted web form (M4-09). The keys are edited in one place,
 * Channels › Widget › "Check for bots", and read here by both.
 *
 * The secret is decrypted only to be handed to the provider's siteverify
 * call; it is never logged and never leaves the process otherwise.
 */

export interface BrandCaptchaKeys {
  readonly provider: CaptchaProvider;
  readonly siteKey: string;
  readonly secret: string;
}

export interface CaptchaKeysReader {
  /** The brand's keys, or null while either half is missing. */
  forBrand(brandId: string, tx?: DbTransaction): Promise<BrandCaptchaKeys | null>;
}

export class DbCaptchaKeys implements CaptchaKeysReader {
  readonly #db: Db;
  readonly #keyring: Keyring;
  readonly #repository = new WidgetSettingsRepository();

  constructor(db: Db, keyring: Keyring) {
    this.#db = db;
    this.#keyring = keyring;
  }

  async forBrand(brandId: string, tx?: DbTransaction): Promise<BrandCaptchaKeys | null> {
    const read = (inner: DbTransaction) => this.#repository.captcha(inner, brandId);
    const stored = resolveCaptcha(
      tx === undefined
        ? await withSystemJob(this.#db, brandId, 'captcha-keys', read)
        : await read(tx),
    );
    if (stored.secret === null || stored.siteKey === '') {
      return null;
    }

    const secret = z.string().safeParse(JSON.parse(decryptSecret(stored.secret, this.#keyring)));
    return secret.success && secret.data !== ''
      ? { provider: stored.provider, siteKey: stored.siteKey, secret: secret.data }
      : null;
  }
}

/** The siteverify POST, through the SSRF-safe client like every call out (DOMAIN-RULES §13). */
export const safeCaptchaTransport = (allowCidrs: readonly string[]): CaptchaTransport => ({
  postForm: async (url, form) => {
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      { ...policies.webhook, allowCidrs: [...allowCidrs] },
    );
    return { status: response.status, body: response.body.toString('utf8') };
  },
});

export type CaptchaCheck = 'passed' | 'failed' | 'not_configured';

/** "Is this token good for this brand?", in one call for the widget and the form. */
export class CaptchaVerifier {
  readonly #keys: CaptchaKeysReader;
  readonly #adapter: (provider: CaptchaProvider) => CaptchaAdapter;

  constructor(keys: CaptchaKeysReader, transport: CaptchaTransport) {
    this.#keys = keys;
    this.#adapter = (provider) => createCaptchaProvider(provider, transport);
  }

  async verify(input: {
    readonly brandId: string;
    readonly token: string | undefined;
    readonly remoteIp: string | null;
    readonly tx?: DbTransaction;
  }): Promise<CaptchaCheck> {
    const keys = await this.#keys.forBrand(input.brandId, input.tx);
    if (keys === null) {
      return 'not_configured';
    }
    if (input.token === undefined || input.token === '') {
      return 'failed';
    }

    try {
      const verdict = await this.#adapter(keys.provider).verify({
        secret: keys.secret,
        token: input.token,
        remoteIp: input.remoteIp,
      });
      return verdict.success ? 'passed' : 'failed';
    } catch {
      // A provider that cannot be reached fails closed: ADR 0003 asks for a
      // visible error rather than a check that silently passes.
      return 'failed';
    }
  }
}
