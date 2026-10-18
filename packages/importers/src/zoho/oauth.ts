import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ImportHttp } from '../http.js';
import { isInvalidUtf8 } from '../utf8.js';
import { ZOHO_REGIONS, type ZohoCredentials, zohoCredentialsSchema } from './regions.js';

export const zohoAccessTokenSchema = z.strictObject({
  value: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
  expiresAt: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const responseSchema = z.object({
  access_token: zohoAccessTokenSchema.shape.value,
  api_domain: z.url(),
  token_type: z.literal('Bearer'),
  expires_in: z.int().min(1).max(3600),
});

export type ZohoAccessToken = z.infer<typeof zohoAccessTokenSchema>;

/** Sessions live for a connection; resumable workers supply an encrypted token snapshot. */
export class ZohoOAuthSession {
  private token: ZohoAccessToken | undefined;
  private pending: Promise<string> | undefined;
  private readonly credentials: ZohoCredentials;

  constructor(
    credentials: ZohoCredentials,
    private readonly http: ImportHttp,
    private readonly options: {
      signal: AbortSignal;
      accountsRoot?: string;
      now?: () => number;
      initialAccessToken?: ZohoAccessToken;
      saveAccessToken?: (token: ZohoAccessToken) => Promise<void>;
    },
  ) {
    this.credentials = zohoCredentialsSchema.parse(credentials);
    if (options.initialAccessToken)
      this.token = zohoAccessTokenSchema.parse(options.initialAccessToken);
  }

  invalidate(rejectedToken: string): void {
    // A late 401 must not discard a token another request has just refreshed.
    if (this.token?.value === rejectedToken) this.token = undefined;
  }

  accessToken(): Promise<string> {
    this.options.signal.throwIfAborted();
    const now = this.options.now?.() ?? Date.now();
    if (this.token && this.token.expiresAt > now + 30_000) return Promise.resolve(this.token.value);
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async refresh(): Promise<string> {
    const { region, clientId, clientSecret, refreshToken } = this.credentials;
    const regionHosts = ZOHO_REGIONS[region];
    const endpoint = new URL('/oauth/v2/token', this.options.accountsRoot ?? regionHosts.accounts);
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const started = this.options.now?.() ?? Date.now();
    let response: Awaited<ReturnType<ImportHttp['request']>>;
    try {
      response = await this.http.request(
        endpoint.href,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: this.options.signal,
        },
        { followRedirects: false },
      );
    } catch (error) {
      if (error instanceof ConnectorError && error.code === 'record-unavailable')
        throw new ConnectorError('invalid-response', error.status, error.responseOrigin);
      throw error;
    }
    // Zoho can return OAuth errors as JSON with HTTP 200. Never surface that body.
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
    } catch (error) {
      if (error instanceof SyntaxError || isInvalidUtf8(error))
        throw new ConnectorError('invalid-response');
      throw error;
    }
    const parsed = responseSchema.safeParse(decoded);
    if (!parsed.success) {
      const refusal = z
        .object({
          error: z.enum([
            'invalid_client',
            'invalid_client_secret',
            'invalid_code',
            'invalid_grant',
          ]),
        })
        .safeParse(decoded);
      throw new ConnectorError(refusal.success ? 'credentials-refused' : 'invalid-response');
    }
    // Desk-specific documentation promises a Desk api_domain. Generic Zoho API
    // domains and cross-region results are refused rather than guessed or fetched.
    const api = new URL(parsed.data.api_domain);
    if (
      api.origin !== regionHosts.desk ||
      api.username ||
      api.password ||
      api.pathname !== '/' ||
      api.search ||
      api.hash
    )
      throw new ConnectorError('invalid-response');
    const token = zohoAccessTokenSchema.parse({
      value: parsed.data.access_token,
      expiresAt: started + parsed.data.expires_in * 1000,
    });
    await this.options.saveAccessToken?.(token);
    this.token = token;
    return token.value;
  }
}
