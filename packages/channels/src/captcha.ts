import { z } from 'zod';

/**
 * ADR 0003: one `CaptchaProvider` interface, two adapters — Cloudflare
 * Turnstile (the default) and hCaptcha. The widget asks for a challenge before
 * a visitor's first message (M4-03) and the web form before a submission
 * (M4-09); both read the brand's one set of keys and verify through here.
 *
 * The HTTP call is not made here. It is handed a {@link CaptchaTransport},
 * which the api builds on the SSRF-safe client (`@helpdock/net`, DOMAIN-RULES
 * §13) "so that there is exactly one audited path out of the process" — and
 * which a test replaces with a recorder.
 */

export const CAPTCHA_PROVIDERS = ['turnstile', 'hcaptcha'] as const;
export type CaptchaProviderName = (typeof CAPTCHA_PROVIDERS)[number];

export interface CaptchaTransport {
  /** A form-encoded POST; answers the status and the body as text. */
  postForm(url: string, form: URLSearchParams): Promise<{ status: number; body: string }>;
}

export interface CaptchaVerifyInput {
  readonly secret: string;
  /** What the widget or the form got from the provider's script. */
  readonly token: string;
  readonly remoteIp?: string | null;
  /** Turnstile only: lets a retry of the same check be answered once. */
  readonly idempotencyKey?: string;
}

export type CaptchaVerdict =
  | { readonly success: true; readonly hostname: string | null }
  | { readonly success: false; readonly errorCodes: readonly string[] };

export interface CaptchaProvider {
  readonly name: CaptchaProviderName;
  /** What a client needs to render the challenge. The site key is public. */
  renderConfig(siteKey: string): {
    readonly provider: CaptchaProviderName;
    readonly siteKey: string;
  };
  verify(input: CaptchaVerifyInput): Promise<CaptchaVerdict>;
}

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';

/** Both providers answer this shape; anything else is a failure, not a pass. */
const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  'error-codes': z.array(z.string()).optional(),
});

const parseVerdict = (status: number, body: string): CaptchaVerdict => {
  if (status < 200 || status >= 300) {
    return { success: false, errorCodes: [`http-${String(status)}`] };
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { success: false, errorCodes: ['invalid-response'] };
  }

  const parsed = siteverifyResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { success: false, errorCodes: ['invalid-response'] };
  }

  return parsed.data.success
    ? { success: true, hostname: parsed.data.hostname ?? null }
    : { success: false, errorCodes: parsed.data['error-codes'] ?? [] };
};

const createProvider = (
  name: CaptchaProviderName,
  url: string,
  transport: CaptchaTransport,
): CaptchaProvider => ({
  name,
  renderConfig: (siteKey) => ({ provider: name, siteKey }),
  verify: async ({ secret, token, remoteIp, idempotencyKey }) => {
    if (token.trim() === '') {
      // Not worth a round trip: both providers answer `missing-input-response`.
      return { success: false, errorCodes: ['missing-input-response'] };
    }

    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp != null && remoteIp !== '') {
      form.set('remoteip', remoteIp);
    }
    if (name === 'turnstile' && idempotencyKey !== undefined) {
      form.set('idempotency_key', idempotencyKey);
    }

    const response = await transport.postForm(url, form);
    return parseVerdict(response.status, response.body);
  },
});

export const createCaptchaProvider = (
  name: CaptchaProviderName,
  transport: CaptchaTransport,
): CaptchaProvider =>
  createProvider(
    name,
    name === 'turnstile' ? TURNSTILE_VERIFY_URL : HCAPTCHA_VERIFY_URL,
    transport,
  );
