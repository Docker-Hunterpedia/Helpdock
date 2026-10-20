import { registerEventHandler } from '@helpdock/jobs';
import { generate } from 'otplib';
import { AUTH_EMAIL_EVENT } from '../auth/auth-email.js';

/**
 * A staff sign-in for the integration suites, the way a person would do it.
 *
 * The suites sign in as the seeded Admin, and since ASVS 4.3.1 an Admin
 * without an authenticator is sent to enrolment rather than given a session.
 * So the first sign-in of an address enrols one, the second answers the code
 * and trusts the browser, and every later one presents that browser's cookie
 * and goes straight in — no suite waits for an authenticator step to roll
 * over, and none needs to know which accounts must have a second factor.
 *
 * State is per test file (Vitest isolates modules per file), keyed by address.
 */

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly cookies: readonly { readonly name: string; readonly value: string }[];
  json(): unknown;
}

export interface Injectable {
  inject(request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
  }): Promise<InjectResponse>;
}

/** The same calls over real HTTP, for the perf harness, which talks to running processes. */
export const overHttp = (baseUrl: string): Injectable => ({
  inject: async ({ method, url, headers, payload }) => {
    const response = await fetch(`${baseUrl}${url}`, { method, headers, body: payload });
    const body = await response.text();
    return {
      statusCode: response.status,
      body,
      cookies: response.headers.getSetCookie().map((cookie) => {
        const [pair = ''] = cookie.split(';');
        const at = pair.indexOf('=');
        return { name: pair.slice(0, at), value: pair.slice(at + 1) };
      }),
      json: () => JSON.parse(body) as unknown,
    };
  },
});

interface Remembered {
  readonly secret: string;
  trustCookie?: string;
}

const accounts = new Map<string, Remembered>();
const PERIOD_SECONDS = 30;

const post = (app: Injectable, url: string, body: unknown, cookie?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    payload: JSON.stringify(body),
  });

/** The step after the one enrolment used, which the window of one already accepts. */
const nextCode = (secret: string): Promise<string> =>
  generate({
    secret,
    period: PERIOD_SECONDS,
    epoch: (Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + 1) * PERIOD_SECONDS,
  });

const sessionFrom = (response: InjectResponse, what: string): InjectResponse => {
  if ((response.json() as { accessToken?: string }).accessToken === undefined) {
    throw new Error(`${what} did not produce a session: ${response.body}`);
  }
  return response;
};

export interface StaffCredentials {
  readonly email: string;
  readonly password: string;
}

/** The response that carried the session, for a suite that wants its cookies too. */
export const signInResponseForTest = async (
  app: Injectable,
  { email, password }: StaffCredentials,
): Promise<InjectResponse> => {
  const known = accounts.get(email);
  const first = await post(app, '/api/auth/sign-in', { email, password }, known?.trustCookie);
  const outcome = first.json() as { kind?: string; challengeId?: string };

  if (outcome.kind === 'session') {
    return sessionFrom(first, 'sign-in');
  }

  if (outcome.kind === 'totp-enrolment-required') {
    const staged = await post(app, '/api/auth/enrolment/start', {
      challengeId: outcome.challengeId,
    });
    const { secret } = staged.json() as { secret: string };
    const enrolled = await post(app, '/api/auth/enrolment/confirm', {
      challengeId: outcome.challengeId,
      code: await generate({ secret, period: PERIOD_SECONDS }),
    });
    accounts.set(email, { secret });
    return sessionFrom(enrolled, 'enrolment');
  }

  if (outcome.kind === 'totp-required' && known !== undefined) {
    const verified = await post(app, '/api/auth/totp', {
      challengeId: outcome.challengeId,
      code: await nextCode(known.secret),
      trustDevice: true,
    });
    const trust = verified.cookies.find((cookie) => cookie.name.endsWith('hd_trust'));
    if (trust !== undefined) {
      known.trustCookie = `${trust.name}=${trust.value}`;
    }
    return sessionFrom(verified, 'the second factor');
  }

  throw new Error(`sign-in as ${email} did not produce a session: ${first.body}`);
};

export const signInForTest = async (app: Injectable, credentials: StaffCredentials) =>
  ((await signInResponseForTest(app, credentials)).json() as { accessToken: string }).accessToken;

/**
 * For the suites that sign in with a seeded authenticator secret: the api
 * accepts each code once (ASVS 2.8.4), and a suite signs in faster than the
 * code changes. Forgetting which steps were used lets it sign in again now
 * rather than in thirty seconds.
 */
export const forgetUsedTotpSteps = async (redis: {
  keys(pattern: string): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
}): Promise<void> => {
  const keys = await redis.keys('auth:totp-step:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
};

/**
 * For the suites that drain the whole outbox through the worker's handlers:
 * enrolling the seeded Admin (above) queues the "two-factor was turned on"
 * email, which those suites have no mail server for. Registered once per
 * file, before the drain runs; the email itself is `auth-email.integration.test.ts`'s.
 */
export const ignoreAuthEmailInThisSuite = (): void => {
  registerEventHandler(AUTH_EMAIL_EVENT, () => Promise.resolve());
};
