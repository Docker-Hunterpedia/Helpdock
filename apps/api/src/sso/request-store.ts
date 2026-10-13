import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

export const SSO_REQUEST_TTL_SECONDS = 600;

/** Namespace and schema are protocol-specific so one callback cannot consume another protocol's state. */
export class SsoRequestStore<T> {
  constructor(
    private readonly redis: Redis,
    private readonly namespace: 'oidc' | 'saml' | 'saml-pending' | 'test' | 'test-result',
    private readonly schema: z.ZodType<T>,
  ) {}

  async put(id: string, request: T): Promise<void> {
    const saved = await this.redis.set(
      this.key(id),
      JSON.stringify(this.schema.parse(request)),
      'EX',
      SSO_REQUEST_TTL_SECONDS,
      'NX',
    );
    if (saved === null) throw new Error('SSO request identifier already exists');
  }

  async read(id: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(id));
    if (raw === null) return null;
    const parsed = this.schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async consume(id: string): Promise<T | null> {
    const raw = await this.redis.getdel(this.key(id));
    if (raw === null) return null;
    const parsed = this.schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  private key(id: string): string {
    if (id.length < 16 || id.length > 256) throw new TypeError('Invalid SSO request identifier');
    return `auth:sso:req:${this.namespace}:${createHash('sha256').update(id).digest('hex')}`;
  }
}
