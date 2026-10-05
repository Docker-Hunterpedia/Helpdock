import type { FastifyInstance } from 'fastify';
import { currentRequestContext } from './request-context.js';

/**
 * Copies the client's address and user agent onto the request context once
 * Fastify has resolved them. The tenant interceptor reads them off the request
 * for the request transaction; the auth audit trail writes from transactions of
 * its own (`auth/auth-audit.ts`) and reads them from here.
 */
export const registerClientFacts = (fastify: FastifyInstance): void => {
  fastify.addHook('preHandler', async (request) => {
    const context = currentRequestContext();
    if (context === undefined) {
      return;
    }

    const userAgent = request.headers['user-agent'];
    context.client = {
      ip: request.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    };
  });
};
