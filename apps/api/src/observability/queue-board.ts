import { randomBytes } from 'node:crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter } from '@bull-board/fastify';
import { type Db, users } from '@helpdock/db';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/**
 * Bull Board, embedded (M8-05, ADR 0004 and its amendment in ADR 0017).
 *
 * Bull Board is a page of its own, opened in a new tab, so it cannot carry the
 * admin's bearer token — that lives in the admin's memory. It is reached the
 * way the help center's staff view is (`help-center/site/staff-access.ts`):
 *
 * 1. **A pass.** The System page asks `POST /api/install/system/queue-board`,
 *    an ordinary `@Requires('install:admin')` route, which stores a one-time
 *    pass in Redis for a minute and answers the address that spends it.
 * 2. **A board session.** The new tab opens `…/board/_session?pass=…`; the
 *    pass is spent (`GETDEL`), and the answer sets {@link QUEUE_BOARD_COOKIE},
 *    an opaque id of a session kept in Redis for an hour, scoped to the
 *    board's path, then redirects to the board.
 *
 * Every board request — the page, its assets and its API — checks that
 * session, that the admin's **refresh family is still alive** (so signing out
 * of the admin closes the board on its next request), and that the account
 * is still an active install admin. Anything else is a 401. The board shows
 * every brand's jobs, because queues are install-wide, which is exactly why
 * nothing less than an install admin may open it.
 */

export const QUEUE_BOARD_PATH = '/api/install/queues/board';
export const QUEUE_BOARD_COOKIE = 'hd_queue_board';
const SESSION_ROUTE = '/_session';
const PASS_TTL_SECONDS = 60;
const SESSION_TTL_SECONDS = 60 * 60;
const PASS_PREFIX = 'hd:queue-board:pass:';
const SESSION_PREFIX = 'hd:queue-board:session:';
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The board's own page needs styles inline and Google's fonts; everything
 * else stays as strict as the api's default (`http/security-headers.ts`).
 */
const BOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const grantSchema = z.object({ userId: z.uuid(), familyId: z.string().min(1) });
type Grant = z.infer<typeof grantSchema>;

/** What the family check needs of `RefreshStore`. */
export interface FamilyLookup {
  userOfFamily(familyId: string): Promise<string | null>;
}

export class QueueBoardAccess {
  readonly #redis: Redis;
  readonly #db: Db;
  readonly #families: FamilyLookup;

  constructor(options: { redis: Redis; db: Db; families: FamilyLookup }) {
    this.#redis = options.redis;
    this.#db = options.db;
    this.#families = options.families;
  }

  /** Stores a one-time pass and answers the address that spends it. */
  async issuePass(grant: Grant): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.#redis.set(
      `${PASS_PREFIX}${token}`,
      JSON.stringify(grantSchema.parse(grant)),
      'EX',
      PASS_TTL_SECONDS,
    );

    return `${QUEUE_BOARD_PATH}${SESSION_ROUTE}?pass=${token}`;
  }

  /** Spends a pass for a session id, or null for a pass that is unknown, used or expired. */
  async openSession(pass: string): Promise<string | null> {
    const grant = await this.#take(PASS_PREFIX, pass, 'getdel');
    if (grant === null) {
      return null;
    }
    const session = randomBytes(24).toString('base64url');
    await this.#redis.set(
      `${SESSION_PREFIX}${session}`,
      JSON.stringify(grant),
      'EX',
      SESSION_TTL_SECONDS,
    );

    return session;
  }

  /** Whether this session id still opens the board; see the file comment. */
  async allows(session: string | undefined): Promise<boolean> {
    try {
      const grant = await this.#take(SESSION_PREFIX, session ?? '', 'get');
      if (grant === null || (await this.#families.userOfFamily(grant.familyId)) !== grant.userId) {
        return false;
      }
      const [account] = await this.#db
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.id, grant.userId), eq(users.installAdmin, true), eq(users.status, 'active')),
        )
        .limit(1);

      return account !== undefined;
    } catch {
      // Redis or the database unreachable counts as signed out.
      return false;
    }
  }

  async #take(prefix: string, token: string, how: 'get' | 'getdel'): Promise<Grant | null> {
    if (!TOKEN.test(token)) {
      return null;
    }
    const stored =
      how === 'getdel'
        ? await this.#redis.getdel(`${prefix}${token}`)
        : await this.#redis.get(`${prefix}${token}`);
    if (stored === null) {
      return null;
    }
    try {
      const parsed = grantSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

const cookieOf = (request: FastifyRequest): string | undefined =>
  (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[
    QUEUE_BOARD_COOKIE
  ];

/**
 * Mounts the board on the Fastify instance, before Nest adds its own routes.
 * It is a Fastify plugin rather than a Nest route because Bull Board brings
 * its own router, assets and views; the session check above is what stands
 * in for `@Requires('install:admin')` on every one of them.
 */
export const registerQueueBoard = async (
  fastify: FastifyInstance,
  options: {
    readonly access: QueueBoardAccess;
    readonly queues: readonly Queue[];
    readonly secure: boolean;
  },
): Promise<void> => {
  const adapter = new FastifyAdapter();
  createBullBoard({
    queues: options.queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter: adapter,
  });
  adapter.setBasePath(QUEUE_BOARD_PATH);

  await fastify.register(async (scope) => {
    scope.get(`${QUEUE_BOARD_PATH}${SESSION_ROUTE}`, async (request, reply: FastifyReply) => {
      const pass = (request.query as { pass?: unknown }).pass;
      const session = typeof pass === 'string' ? await options.access.openSession(pass) : null;
      if (session === null) {
        return reply
          .code(401)
          .type('text/plain')
          .send('This link has expired. Open it again from the System page.');
      }
      reply.setCookie(QUEUE_BOARD_COOKIE, session, {
        path: QUEUE_BOARD_PATH,
        httpOnly: true,
        secure: options.secure,
        sameSite: 'strict',
        maxAge: SESSION_TTL_SECONDS,
      });
      return reply.redirect(`${QUEUE_BOARD_PATH}/`, 303);
    });

    scope.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith(`${QUEUE_BOARD_PATH}${SESSION_ROUTE}`)) {
        return;
      }
      if (!(await options.access.allows(cookieOf(request)))) {
        await reply
          .code(401)
          .type('text/plain')
          .send(
            'Sign in to the admin as an install admin and open the queue dashboard from the System page.',
          );
      }
    });
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('content-security-policy', BOARD_CSP);
      reply.header('cache-control', 'no-store');
      return payload;
    });

    await scope.register(adapter.registerPlugin(), { prefix: QUEUE_BOARD_PATH });
  });
};
