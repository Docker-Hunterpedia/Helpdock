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

/**
 * What a server-rendered page (the web form) needs to draw the challenge, and
 * the CSP sources it must allow. The widget loads the providers' scripts
 * itself and reads only `provider` and `siteKey`.
 */
export interface CaptchaRenderConfig {
  readonly provider: CaptchaProviderName;
  readonly siteKey: string;
  /** Loaded `async defer`; the provider renders into every element with {@link widgetClass}. */
  readonly scriptUrl: string;
  readonly widgetClass: string;
  /** The form field the provider's script fills with the token. */
  readonly responseField: string;
  readonly csp: {
    readonly scriptSrc: readonly string[];
    readonly frameSrc: readonly string[];
    readonly styleSrc: readonly string[];
    readonly connectSrc: readonly string[];
  };
}

export interface CaptchaProvider {
  readonly name: CaptchaProviderName;
  /** What a client needs to render the challenge. The site key is public. */
  renderConfig(siteKey: string, locale: string): CaptchaRenderConfig;
  verify(input: CaptchaVerifyInput): Promise<CaptchaVerdict>;
}

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_VERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
export const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';
const HCAPTCHA_ORIGINS = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];

/** A token is a few hundred characters; far more is not a token. */
const MAX_TOKEN_LENGTH = 4096;

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

/** Answers that are not worth a round trip: the provider would refuse them too. */
const refuseEarly = ({ secret, token }: CaptchaVerifyInput): CaptchaVerdict | null => {
  if (secret === '') {
    return { success: false, errorCodes: ['missing-input-secret'] };
  }
  if (token.trim() === '') {
    return { success: false, errorCodes: ['missing-input-response'] };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { success: false, errorCodes: ['invalid-input-response'] };
  }
  return null;
};

const renderConfigFor = (
  name: CaptchaProviderName,
  siteKey: string,
  locale: string,
): CaptchaRenderConfig =>
  name === 'turnstile'
    ? {
        provider: name,
        siteKey,
        scriptUrl: `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`,
        widgetClass: 'cf-turnstile',
        responseField: 'cf-turnstile-response',
        csp: {
          scriptSrc: [TURNSTILE_ORIGIN],
          frameSrc: [TURNSTILE_ORIGIN],
          styleSrc: [],
          connectSrc: [],
        },
      }
    : {
        provider: name,
        siteKey,
        scriptUrl: `https://js.hcaptcha.com/1/api.js?hl=${encodeURIComponent(locale)}`,
        widgetClass: 'h-captcha',
        responseField: 'h-captcha-response',
        csp: {
          scriptSrc: HCAPTCHA_ORIGINS,
          frameSrc: HCAPTCHA_ORIGINS,
          styleSrc: HCAPTCHA_ORIGINS,
          connectSrc: HCAPTCHA_ORIGINS,
        },
      };

const createProvider = (
  name: CaptchaProviderName,
  url: string,
  transport: CaptchaTransport,
): CaptchaProvider => ({
  name,
  renderConfig: (siteKey, locale) => renderConfigFor(name, siteKey, locale),
  verify: async (input) => {
    const refused = refuseEarly(input);
    if (refused !== null) {
      return refused;
    }

    const { secret, token, remoteIp, idempotencyKey } = input;
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp != null && remoteIp !== '') {
      form.set('remoteip', remoteIp);
    }
    if (name === 'turnstile' && idempotencyKey !== undefined) {
      form.set('idempotency_key', idempotencyKey);
    }

    let response: { status: number; body: string };
    try {
      response = await transport.postForm(url, form);
    } catch {
      // Unreachable is a refusal, never a pass (ADR 0003: fail closed).
      return { success: false, errorCodes: ['network-error'] };
    }
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
