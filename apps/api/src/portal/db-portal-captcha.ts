import type { PowChallenge } from '@helpdock/channels';
import type { Db } from '@helpdock/db';
import type { CaptchaKeysReader } from '../captcha/captcha-keys.js';
import type { PowCaptcha } from '../captcha/pow-captcha.js';
import { WebFormRepository } from '../web-form/web-form.repository.js';
import type { PortalCaptcha } from './portal-site.js';
import { asSystem } from './portal-store.js';

/**
 * The sign-in form's check (M21-02): the built-in proof of work (ADR 0052),
 * required exactly when the brand's web form requires it, with the same
 * difficulty. A third-party provider (Turnstile and the others) renders its own
 * script and frame under the web form's own policy, so it is not drawn here:
 * the portal's per-address and per-IP limits still apply.
 */
export class DbPortalCaptcha implements PortalCaptcha {
  readonly #db: Db;
  readonly #keys: CaptchaKeysReader;
  readonly #pow: Pick<PowCaptcha, 'issue' | 'spend'>;
  readonly #webForm = new WebFormRepository();

  constructor(options: {
    readonly db: Db;
    readonly keys: CaptchaKeysReader;
    readonly pow: Pick<PowCaptcha, 'issue' | 'spend'>;
  }) {
    this.#db = options.db;
    this.#keys = options.keys;
    this.#pow = options.pow;
  }

  async #difficulty(brandId: string) {
    const enabled = await asSystem(
      this.#db,
      brandId,
      async (tx) => (await this.#webForm.settings(tx, brandId))?.captchaEnabled ?? false,
    );
    if (!enabled) {
      return null;
    }
    const keys = await this.#keys.forBrand(brandId);
    return keys?.provider === 'pow' ? keys.difficulty : null;
  }

  async required(brandId: string): Promise<boolean> {
    return (await this.#difficulty(brandId)) !== null;
  }

  async challenge(brandId: string): Promise<PowChallenge | null> {
    const difficulty = await this.#difficulty(brandId);
    return difficulty === null ? null : this.#pow.issue(brandId, difficulty, 'portal-sign-in');
  }

  async spend(brandId: string, token: string): Promise<boolean> {
    return (await this.#pow.spend(brandId, token, 'portal-sign-in')).success;
  }
}
