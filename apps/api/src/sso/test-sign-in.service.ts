import { randomBytes } from 'node:crypto';
import type { Env } from '@helpdock/config';
import { ssoTestResultSchema } from '@helpdock/schemas';
import { ForbiddenException, GoneException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { requireRequestContext } from '../context/request-context.js';
import type { SsoIdentityService } from './identity.service.js';
import type { SsoAssertion } from './oidc-contracts.js';
import { SsoRequestStore } from './request-store.js';
import type { SsoService } from './sso.service.js';

const pendingSchema = z.object({ connectionId: z.uuid(), actorId: z.uuid() });
const completedSchema = pendingSchema.extend({ preview: ssoTestResultSchema });

/** Test previews are single-use, expire in ten minutes, and belong to the initiating install admin. */
export class SsoTestSignInService {
  readonly #pending: SsoRequestStore<z.infer<typeof pendingSchema>>;
  readonly #completed: SsoRequestStore<z.infer<typeof completedSchema>>;

  constructor(
    private readonly options: {
      redis: Redis;
      env: Env;
      identities: SsoIdentityService;
      sso: SsoService;
    },
  ) {
    this.#pending = new SsoRequestStore(options.redis, 'test', pendingSchema);
    this.#completed = new SsoRequestStore(options.redis, 'test-result', completedSchema);
  }

  async start(connectionId: string) {
    const actorId = this.#actor();
    const connection = await this.options.sso.get(connectionId);
    if (!connection.enabled) throw new GoneException('Enable this connection before testing it');
    const key = randomBytes(32).toString('base64url');
    await this.#pending.put(key, { connectionId, actorId });
    const url = new URL(`/api/auth/sso/${connectionId}/start`, this.options.env.APP_URL);
    url.searchParams.set('returnTo', `/admin/settings/sso/${connectionId}?test=${key}`);
    return { startUrl: url.toString() };
  }

  async complete(flow: { assertion: SsoAssertion; returnTo: string }): Promise<string | null> {
    const destination = new URL(flow.returnTo, this.options.env.APP_URL);
    if (
      destination.pathname !== `/admin/settings/sso/${flow.assertion.connectionId}` ||
      !destination.searchParams.has('test')
    )
      return null;
    const key = destination.searchParams.get('test') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new GoneException('Connection test expired');
    const pending = await this.#pending.consume(key);
    if (!pending || pending.connectionId !== flow.assertion.connectionId)
      throw new GoneException('Connection test expired');
    const computed = await this.options.identities.preview(flow.assertion);
    const { subject, email, name, groups } = flow.assertion;
    await this.#completed.put(key, {
      ...pending,
      preview: {
        ...computed,
        claims: { subject, email, ...(name === undefined ? {} : { name }), groups },
      },
    });
    return destination.toString();
  }

  async result(connectionId: string, key: string) {
    const stored = await this.#completed.read(key);
    if (!stored) throw new GoneException('Connection test expired');
    if (stored.actorId !== this.#actor() || stored.connectionId !== connectionId)
      throw new ForbiddenException('This connection test belongs to another administrator');
    const consumed = await this.#completed.consume(key);
    if (!consumed) throw new GoneException('Connection test expired');
    return consumed.preview;
  }

  #actor(): string {
    const actor = requireRequestContext().principal;
    if (actor?.type !== 'staff' || !actor.installAdmin)
      throw new ForbiddenException('Install admin required');
    return actor.id;
  }
}
