import type {
  SetupAdminRequest,
  SetupAdminResponse,
  SetupBrandRequest,
  SetupBrandResponse,
  SetupCompleteResponse,
  SetupSmtpRequest,
  SetupSmtpResponse,
  SmtpCredentials,
  SmtpTestResult,
} from '@helpdock/schemas';
import {
  errorResponseSchema,
  SETUP_TOKEN_HEADER,
  setupAdminResponseSchema,
  setupBrandResponseSchema,
  setupCompleteResponseSchema,
  setupSmtpResponseSchema,
  smtpTestResultSchema,
} from '@helpdock/schemas';
import type { ZodType } from 'zod';

/**
 * The four calls the wizard makes, parsed through the schemas the api answers
 * with. Parsing rather than casting is the point: the done screen summarises
 * what the server actually created, and a field that quietly arrived as
 * `undefined` would be summarised as blank.
 *
 * The wizard token lives in a field on this object and nowhere else — not in
 * `localStorage`, not in a cookie — for the same reason the access token does
 * in `HttpAuthApi`: a reload has nothing to resume, and that is correct, because
 * a half-finished wizard is finished by starting it again.
 */

/** The wizard is closed: the install is set up, or the token has expired. */
export class SetupClosedError extends Error {
  constructor() {
    super('setup: closed');
    this.name = 'SetupClosedError';
  }
}

export class SetupThrottledError extends Error {
  constructor() {
    super('setup: throttled');
    this.name = 'SetupThrottledError';
  }
}

/** A field the api refused. `path` is as the request carried it (`body.prefix`). */
export class SetupValidationError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(`setup: invalid ${paths.join(', ')}`);
    this.name = 'SetupValidationError';
    this.paths = paths;
  }
}

export class SetupApiError extends Error {
  constructor(message: string) {
    super(`setup: ${message}`);
    this.name = 'SetupApiError';
  }
}

export interface SetupApi {
  createAdmin(request: SetupAdminRequest): Promise<SetupAdminResponse>;
  createBrand(request: SetupBrandRequest): Promise<SetupBrandResponse>;
  testSmtp(request: SmtpCredentials): Promise<SmtpTestResult>;
  saveSmtp(request: SetupSmtpRequest): Promise<SetupSmtpResponse>;
  complete(): Promise<SetupCompleteResponse>;
}

export class HttpSetupApi implements SetupApi {
  readonly #baseUrl: string;
  #setupToken: string | null = null;

  constructor(baseUrl = '/api') {
    this.#baseUrl = baseUrl;
  }

  async createAdmin(request: SetupAdminRequest): Promise<SetupAdminResponse> {
    const response = await this.#post('/install/setup/admin', request, setupAdminResponseSchema);
    this.#setupToken = response.setupToken;

    return response;
  }

  createBrand(request: SetupBrandRequest): Promise<SetupBrandResponse> {
    return this.#post('/install/setup/brand', request, setupBrandResponseSchema);
  }

  testSmtp(request: SmtpCredentials): Promise<SmtpTestResult> {
    return this.#post('/install/setup/smtp/test', request, smtpTestResultSchema);
  }

  saveSmtp(request: SetupSmtpRequest): Promise<SetupSmtpResponse> {
    return this.#post('/install/setup/smtp', request, setupSmtpResponseSchema);
  }

  complete(): Promise<SetupCompleteResponse> {
    return this.#post('/install/setup/complete', undefined, setupCompleteResponseSchema);
  }

  async #post<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      // Step 2 sets the refresh cookie, which is what signs the admin in.
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.#setupToken === null ? {} : { [SETUP_TOKEN_HEADER]: this.#setupToken }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw await toSetupError(response);
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new SetupApiError('the api answered a shape this build does not understand');
    }

    return parsed.data;
  }
}

/**
 * The three refusals the screens draw differently — closed, throttled, a field
 * the server would not take — and one sentence for everything else.
 */
const toSetupError = async (response: Response): Promise<Error> => {
  if (response.status === 429) {
    return new SetupThrottledError();
  }
  if (response.status === 409) {
    return new SetupClosedError();
  }

  if (response.status === 400) {
    try {
      const body = errorResponseSchema.parse(await response.json());
      return new SetupValidationError((body.error.fields ?? []).map((field) => field.path));
    } catch {
      return new SetupValidationError([]);
    }
  }

  return new SetupApiError(`the api answered ${String(response.status)}`);
};
