import {
  type CaptchaProvider as CaptchaAdapter,
  type CaptchaSurface,
  type CaptchaTransport,
  createCaptchaProvider,
  type SiteverifyProviderName,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import type { Db, DbTransaction } from '@helpdock/db';
import { safeFetch } from '@helpdock/net';
import type { CaptchaDifficulty } from '@helpdock/schemas';
import { z } from 'zod';
import { withSystemJob } from '../tenant/system-job.js';
import { resolveCaptcha } from '../widget/resolved-settings.js';
import { WidgetSettingsRepository } from '../widget/widget-settings.repository.js';
import type { PowCaptcha } from './pow-captcha.js';

/**
 * A brand's CAPTCHA keys (ADR 0003), read-only, for the two visitor-facing
 * surfaces that ask for a challenge: the widget before a first message
 * (M4-03) and the hosted web form (M4-09). The keys are edited in one place,
 * Channels › Widget › "Check for bots", and read here by both.
 *
 * The secret is decrypted only to be handed to the provider's siteverify
 * call; it is never logged and never leaves the process otherwise.
 *
 * The built-in `pow` (ADR 0052) has no keys: it is ready as soon as it is
 * chosen, with the brand's difficulty.
 */

export type BrandCaptchaKeys =
  | { readonly provider: 'pow'; readonly difficulty: CaptchaDifficulty }
  | {
      readonly provider: SiteverifyProviderName;
      readonly siteKey: string;
      readonly secret: string;
    };

export interface CaptchaKeysReader {
  /** What the brand's check needs, or null while a third-party provider lacks either key. */
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
    if (stored.provider === 'pow') {
      return { provider: 'pow', difficulty: stored.difficulty };
    }
    if (stored.secret === null || stored.siteKey === '') {
      return null;
    }

    const secret = z.string().safeParse(JSON.parse(decryptSecret(stored.secret, this.#keyring)));
    return secret.success && secret.data !== ''
      ? { provider: stored.provider, siteKey: stored.siteKey, secret: secret.data }
      : null;
  }
}

/** A siteverify answer is a few hundred bytes. */
const VERIFY_BODY_LIMIT = 64 * 1024;
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * The siteverify POST, through the SSRF-safe client like every call out
 * (DOMAIN-RULES §13), even though the host is ours to choose: small, quick and
 * never redirected.
 */
export const safeCaptchaTransport = (allowCidrs: readonly string[]): CaptchaTransport => ({
  postForm: async (url, form) => {
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      {
        maxBodyBytes: VERIFY_BODY_LIMIT,
        totalTimeoutMs: VERIFY_TIMEOUT_MS,
        maxRedirects: 0,
        allowCidrs: [...allowCidrs],
      },
    );
    return { status: response.status, body: response.body.toString('utf8') };
  },
});

export type CaptchaCheck = 'passed' | 'failed' | 'not_configured';

/** Where a refusal's reason goes: the provider's error codes, never the token or the secret. */
export interface CaptchaRefusalLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** "Is this token good for this brand?", in one call for the widget and the form. */
export class CaptchaVerifier {
  readonly #keys: CaptchaKeysReader;
  readonly #adapter: (provider: SiteverifyProviderName) => CaptchaAdapter;
  readonly #pow: PowCaptcha;
  readonly #log: CaptchaRefusalLog;

  constructor(
    keys: CaptchaKeysReader,
    transport: CaptchaTransport,
    pow: PowCaptcha,
    log: CaptchaRefusalLog,
  ) {
    this.#keys = keys;
    this.#adapter = (provider) => createCaptchaProvider(provider, transport);
    this.#pow = pow;
    this.#log = log;
  }

  async verify(input: {
    readonly brandId: string;
    readonly token: string | undefined;
    readonly remoteIp: string | null;
    /** Where the challenge may have been solved; see `CaptchaVerifyInput.hostnames`. */
    readonly hostnames: readonly string[];
    /**
     * The surface asking: a Turnstile pass must answer it back with `brandId`,
     * and a `pow` solution is good only for the surface it was issued for.
     */
    readonly surface: CaptchaSurface;
    readonly tx?: DbTransaction;
  }): Promise<CaptchaCheck> {
    const keys = await this.#keys.forBrand(input.brandId, input.tx);
    if (keys === null) {
      return 'not_configured';
    }
    if (input.token === undefined || input.token === '') {
      return 'failed';
    }

    // A provider that cannot be reached answers a refusal (ADR 0003: fail
    // closed), so this never passes on an error.
    const verdict =
      keys.provider === 'pow'
        ? await this.#pow.spend(input.brandId, input.token, input.surface)
        : await this.#adapter(keys.provider).verify({
            secret: keys.secret,
            token: input.token,
            remoteIp: input.remoteIp,
            hostnames: input.hostnames,
            binding: { surface: input.surface, brandId: input.brandId },
          });
    if (!verdict.success) {
      // `action-mismatch`, `cdata-mismatch`, `hostname-mismatch` and a spent
      // built-in solution are otherwise indistinguishable from a wrong token
      // to whoever operates this.
      this.#log.warn(
        { brandId: input.brandId, surface: input.surface, errorCodes: verdict.errorCodes },
        'CAPTCHA refused',
      );
    }
    return verdict.success ? 'passed' : 'failed';
  }
}
