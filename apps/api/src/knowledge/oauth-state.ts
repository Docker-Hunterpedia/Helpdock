import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KnowledgeOAuthProvider } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The `state` of a Notion or Google OAuth round trip (M7-03): which brand,
 * source and person asked, signed with a key derived from `APP_MASTER_KEY`
 * and good for ten minutes. The callback is a public route — the browser
 * arrives from the provider without the admin's bearer token — so the state
 * is the only thing that says the answer belongs to a request this install
 * made, and to which source it may be written.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

const stateSchema = z.object({
  brandId: z.uuid(),
  sourceId: z.uuid(),
  provider: z.enum(['notion', 'gdrive']),
  actorId: z.string().max(100),
  expiresAt: z.int(),
});
export type OAuthState = z.infer<typeof stateSchema>;

export class OAuthStateSigner {
  readonly #key: Buffer;

  constructor(masterKey: string) {
    this.#key = createHmac('sha256', 'hd-knowledge-oauth').update(masterKey).digest();
  }

  sign(
    state: Omit<OAuthState, 'expiresAt' | 'provider'> & { provider: KnowledgeOAuthProvider },
    now = Date.now(),
  ): string {
    const body = Buffer.from(
      JSON.stringify({ ...state, expiresAt: now + OAUTH_STATE_TTL_MS }),
    ).toString('base64url');
    return `${body}.${this.#mac(body)}`;
  }

  /** The state, or null when it was not signed here or has expired. */
  verify(token: string, now = Date.now()): OAuthState | null {
    const [body, mac] = token.split('.');
    if (body === undefined || mac === undefined) {
      return null;
    }
    const expected = Buffer.from(this.#mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    try {
      const state = stateSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      return state.expiresAt > now ? state : null;
    } catch {
      return null;
    }
  }

  #mac(body: string): string {
    return createHmac('sha256', this.#key).update(body).digest('base64url');
  }
}
