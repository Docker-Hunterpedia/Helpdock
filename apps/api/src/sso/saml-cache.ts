import type { CacheProvider } from '@node-saml/node-saml';
import type { Redis } from 'ioredis';
import { ssoHash } from './oidc-contracts.js';
import { SSO_REQUEST_TTL_SECONDS } from './request-store.js';
import { SamlFailure } from './saml-xml.js';

export class SamlCache implements CacheProvider {
  constructor(
    private readonly redis: Redis,
    private readonly connectionId: string,
  ) {}
  private key(id: string) {
    return `auth:sso:saml:cache:${this.connectionId}:${ssoHash(id)}`;
  }
  async saveAsync(id: string, value: string) {
    const saved = await this.redis.set(this.key(id), value, 'EX', SSO_REQUEST_TTL_SECONDS, 'NX');
    return saved === null ? null : { value, createdAt: Date.now() };
  }
  getAsync(id: string) {
    return this.redis.get(this.key(id));
  }
  async removeAsync(id: string | null) {
    return id === null ? null : this.redis.getdel(this.key(id));
  }
}

/** Claim assertion and signed request together; library get/remove alone permits concurrent replay. */
export async function claimSamlResponse(
  redis: Redis,
  input: { connectionId: string; assertionId: string; requestId: string | null },
) {
  const key = (kind: string, id: string) =>
    `auth:sso:saml:replay:${input.connectionId}:${kind}:${ssoHash(id)}`;
  const keys = [key('assertion', input.assertionId)];
  if (input.requestId) keys.push(key('request', input.requestId));
  const claimed = await redis.eval(
    "for i = 1, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end for i = 1, #KEYS do redis.call('SET', KEYS[i], '1', 'EX', ARGV[1]) end return 1",
    keys.length,
    ...keys,
    SSO_REQUEST_TTL_SECONDS + 120,
  );
  if (claimed !== 1) throw new SamlFailure('sso-replay-refused');
}
