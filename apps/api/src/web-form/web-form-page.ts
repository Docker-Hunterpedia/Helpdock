import { randomBytes, randomUUID } from 'node:crypto';
import type { CaptchaRenderConfig, PowChallenge } from '@helpdock/channels';
import type { Locale } from '@helpdock/i18n';
import { webFormPageParamSchema } from '@helpdock/schemas';
import {
  type FormCaptcha,
  LANG_FIELD,
  type PageState,
  type PageView,
  renderWebFormPage,
  SUBMISSION_FIELD,
} from './page/render.js';
import {
  ATTACHMENTS_FIELD,
  articleIdFrom,
  postedArticleId,
  type UploadedFile,
} from './submission.js';
import type { LoadedForm, SubmitResult, WebFormPost } from './web-form-public.service.js';
import { pageLocale } from './web-form-public.service.js';

/**
 * The public page's request handling (M4-09), apart from Nest so the same code
 * answers the api's `/contact` routes and the Playwright server that drives
 * the page in a browser (`apps/api/e2e/`): which brand, which state, which
 * status code, and the CSP the rendered HTML needs.
 *
 * | Outcome | Status |
 * |---|---|
 * | the form, or the thank-you page | 200 |
 * | fields to correct, a failed CAPTCHA | 422 |
 * | a honeypot or a blocked sender | 400 |
 * | a rate limit | 429 |
 * | the form is turned off, or no brand is here | 404 |
 * | CAPTCHA on without keys | 503 |
 */

export const WEB_FORM_PATH = '/contact';

/** Five files at the largest per-file cap a brand is likely to allow, with room for the fields. */
export const WEB_FORM_BODY_LIMIT = 30 * 1024 * 1024;

export interface WebFormForms {
  load(brandId: string, lang: string | undefined): Promise<LoadedForm | null>;
  submit(form: LoadedForm, post: WebFormPost): Promise<SubmitResult>;
  /** The per-IP budget on new built-in challenges: true when one more is allowed, and counts it. */
  allowChallenge(brandId: string, ip: string): Promise<boolean>;
}

/** What `…/challenge` answers. */
export type ChallengeAnswer =
  | { readonly status: 200; readonly challenge: PowChallenge }
  | { readonly status: 404 | 429 };

export interface WebFormPageDependencies {
  readonly forms: WebFormForms;
  /** The brand whose verified help center host this is, or null. */
  resolveHost(host: string | undefined): Promise<string | null>;
  /** Where a submission that failed unexpectedly is reported; the customer is told to try again. */
  readonly log: { error(fields: Record<string, unknown>, message: string): void };
}

export interface WebFormPageRequest {
  readonly host: string | undefined;
  /** From `/contact/<brandId>`; absent on `/contact`. */
  readonly brandId?: string | undefined;
  readonly lang: string | undefined;
  /** `?article=`: the help center article "Still need help?" came from (M5-08). */
  readonly article?: string | undefined;
  readonly ip: string;
  /** Absent for a GET. */
  readonly body?: {
    readonly fields: ReadonlyMap<string, readonly string[]>;
    readonly files: readonly UploadedFile[];
  };
}

export interface WebFormPageResponse {
  readonly status: number;
  readonly html: string;
  readonly contentSecurityPolicy: string;
}

const STATUS_FOR_REFUSAL = {
  captcha: 422,
  rate_limited: 429,
  rejected: 400,
  unavailable: 503,
  failed: 500,
} as const;

/**
 * The built-in check needs no other host: its script is inline under the
 * nonce, and "Try again" fetches the form's own `…/challenge`.
 */
const POW_CSP: CaptchaRenderConfig['csp'] = {
  scriptSrc: [],
  frameSrc: [],
  styleSrc: [],
  connectSrc: ["'self'"],
};

/**
 * The page's policy: nothing but its own nonce'd style and fonts, a form that
 * posts to itself, and — only while a brand has CAPTCHA on — the provider's
 * script and frame (ADR 0003: "added only when that brand has CAPTCHA
 * enabled"), or the built-in check's inline script (ADR 0052).
 */
export const pageContentSecurityPolicy = (nonce: string, captcha: FormCaptcha | null): string => {
  const csp = captcha === null ? null : captcha.provider === 'pow' ? POW_CSP : captcha.csp;
  const extra = (sources: readonly string[] | undefined): string =>
    sources === undefined || sources.length === 0 ? '' : ` ${sources.join(' ')}`;
  const directives = [
    "default-src 'none'",
    `style-src 'self' 'nonce-${nonce}'${extra(csp?.styleSrc)}`,
    "font-src 'self'",
    "img-src 'self' data:",
    csp === null ? "script-src 'none'" : `script-src 'nonce-${nonce}'${extra(csp.scriptSrc)}`,
    ...(csp === null || csp.frameSrc.length === 0 ? [] : [`frame-src${extra(csp.frameSrc)}`]),
    ...(csp === null || csp.connectSrc.length === 0 ? [] : [`connect-src${extra(csp.connectSrc)}`]),
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
};

export class WebFormPage {
  readonly #deps: WebFormPageDependencies;

  constructor(deps: WebFormPageDependencies) {
    this.#deps = deps;
  }

  /**
   * A new built-in challenge for the form's "Try again" (ADR 0052), or null
   * when this host and path serve no open form that asks for one.
   */
  async challenge(request: {
    readonly host: string | undefined;
    readonly brandId?: string | undefined;
    readonly ip: string;
  }): Promise<ChallengeAnswer> {
    const brandId = this.#brandFor(request.brandId, await this.#deps.resolveHost(request.host));
    if (brandId === null) {
      return { status: 404 };
    }
    // Before the reads a load makes, so a flood of Try again costs a counter.
    if (!(await this.#deps.forms.allowChallenge(brandId, request.ip))) {
      return { status: 429 };
    }
    const form = await this.#deps.forms.load(brandId, undefined);
    return form?.state === 'open' && form.captcha?.provider === 'pow'
      ? { status: 200, challenge: form.captcha.challenge }
      : { status: 404 };
  }

  async handle(request: WebFormPageRequest): Promise<WebFormPageResponse> {
    const nonce = randomBytes(16).toString('base64');
    const hostBrand = await this.#deps.resolveHost(request.host);
    const brandId = this.#brandFor(request.brandId, hostBrand);
    const path =
      request.brandId === undefined ? WEB_FORM_PATH : `${WEB_FORM_PATH}/${request.brandId}`;
    const lang = request.body?.fields.get(LANG_FIELD)?.[0] ?? request.lang;

    const form = brandId === null ? null : await this.#deps.forms.load(brandId, lang);
    if (form === null) {
      return this.#respond(404, {
        locale: pageLocale(lang, 'en'),
        brandName: null,
        path,
        helpCenterHref: null,
        nonce,
        state: { kind: 'not_found' },
      });
    }

    const view = {
      locale: form.locale,
      brandName: form.brand.name,
      path,
      helpCenterHref: hostBrand === form.brand.id ? '/' : null,
      nonce,
    };
    if (form.state !== 'open') {
      return this.#respond(form.state === 'closed' ? 404 : 503, {
        ...view,
        state: { kind: form.state },
      });
    }
    if (request.body === undefined) {
      return this.#respond(200, {
        ...view,
        state: this.#formState(form, new Map(), randomUUID(), articleIdFrom(request.article)),
      });
    }

    const post = { fields: request.body.fields, files: request.body.files, ip: request.ip };
    let result: SubmitResult;
    try {
      result = await this.#deps.forms.submit(form, post);
    } catch (error) {
      this.#deps.log.error({ brandId: form.brand.id, err: error }, 'web form submission failed');
      result = { kind: 'refused', error: 'failed' };
    }
    const posted = post.fields.get(SUBMISSION_FIELD)?.[0] ?? randomUUID();
    const article = postedArticleId(post.fields);

    switch (result.kind) {
      case 'created':
        return this.#respond(200, {
          ...view,
          state: { kind: 'success', reference: result.reference, thankYou: form.thankYou },
        });
      case 'invalid':
        return this.#respond(422, {
          ...view,
          state: {
            ...this.#formState(form, post.fields, posted, article),
            fieldErrors: result.errors,
          },
        });
      case 'refused':
        return this.#respond(STATUS_FOR_REFUSAL[result.error], {
          ...view,
          state: {
            ...this.#formState(form, post.fields, posted, article),
            formError: result.error,
          },
        });
    }
  }

  /**
   * A path that names a brand wins, unless the host is another brand's help
   * center: one brand's domain never serves another brand's form.
   */
  #brandFor(pathBrand: string | undefined, hostBrand: string | null): string | null {
    if (pathBrand === undefined) {
      return hostBrand;
    }
    if (!webFormPageParamSchema.safeParse({ brandId: pathBrand }).success) {
      return null;
    }
    return hostBrand === null || hostBrand === pathBrand ? pathBrand : null;
  }

  #formState(
    form: LoadedForm,
    values: ReadonlyMap<string, readonly string[]>,
    submissionId: string,
    articleId: string | null,
  ): Extract<PageState, { kind: 'form' }> {
    return {
      kind: 'form',
      fields: form.fields,
      values,
      fieldErrors: new Map(),
      formError: null,
      submissionId,
      attachments: form.attachments,
      captcha: form.captcha,
      articleId,
    };
  }

  #respond(status: number, view: PageView & { locale: Locale }): WebFormPageResponse {
    const captcha = view.state.kind === 'form' ? view.state.captcha : null;
    return {
      status,
      html: renderWebFormPage(view),
      contentSecurityPolicy: pageContentSecurityPolicy(view.nonce, captcha),
    };
  }
}

/**
 * A posted body as fields and files. Multipart arrives as the raw bytes
 * `inbound-parse-body.ts` hands over and is decoded with the platform's
 * `FormData`; a url-encoded form (a browser with the file control removed)
 * arrives already parsed.
 */
export const readFormBody = async (
  contentType: string | undefined,
  body: unknown,
): Promise<{ fields: Map<string, string[]>; files: UploadedFile[] } | null> => {
  const fields = new Map<string, string[]>();
  const files: UploadedFile[] = [];
  const add = (name: string, value: string): void => {
    fields.set(name, [...(fields.get(name) ?? []), value]);
  };

  if (!Buffer.isBuffer(body)) {
    if (body === null || typeof body !== 'object') {
      return null;
    }
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        add(name, String(item));
      }
    }
    return { fields, files };
  }

  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), {
      headers: { 'content-type': contentType ?? '' },
    }).formData();
  } catch {
    return null;
  }
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      add(name, value);
    } else if (name === ATTACHMENTS_FIELD) {
      files.push({
        filename: value.name,
        contentType: value.type || 'application/octet-stream',
        content: Buffer.from(await value.arrayBuffer()),
      });
    }
  }
  return { fields, files };
};
