import { createHash } from 'node:crypto';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@helpdock/schemas';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { getTx, requireRequestContext } from '../context/request-context.js';
import { IdempotencyRepository } from './idempotency.repository.js';

/**
 * `Idempotency-Key` on the public API's `POST`s (M8-02, REQUIREMENTS §4.11).
 * The first request with a key runs and its answer is stored; a retry with the
 * same key and the same request gets that answer back, marked
 * `Idempotent-Replayed: true`, and nothing runs twice. The same key with a
 * different request is refused 422, and a retry that arrives while the first
 * request is still running waits for it.
 *
 * It runs inside the request's transaction — the tenant interceptor is global
 * and so outside this one — which is what makes it hold: the key, the domain
 * rows and the stored answer commit together, and a request that fails leaves
 * no key behind, so its retry runs for real.
 *
 * Keys are per API key: two integrations that happen to pick the same key do
 * not see each other's answers.
 */

export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

interface IncomingRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
}

interface OutgoingReply {
  header(name: string, value: string): unknown;
}

/** What makes two requests "the same": method, path and body. */
export const requestHashOf = ({ method, url, body }: IncomingRequest): string =>
  createHash('sha256')
    .update(`${method} ${url}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  readonly #repository = new IdempotencyRepository();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IncomingRequest>();
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (header === undefined) {
      return next.handle();
    }
    const key = idempotencyKeySchema.safeParse(Array.isArray(header) ? header[0] : header);
    if (!key.success) {
      throw new BadRequestException(
        'Idempotency-Key must be 1 to 255 printable characters without spaces',
      );
    }

    const reply = context.switchToHttp().getResponse<OutgoingReply>();
    return from(this.#run(key.data, request, reply, next));
  }

  async #run(
    key: string,
    request: IncomingRequest,
    reply: OutgoingReply,
    next: CallHandler,
  ): Promise<unknown> {
    const { principal, targetBrandId } = requireRequestContext();
    /* c8 ignore next 3 -- only `/api/v1` routes carry this interceptor, and only a key reaches them. */
    if (principal?.type !== 'apikey' || targetBrandId === null) {
      return lastValueFrom(next.handle());
    }

    const tx = getTx();
    const requestHash = requestHashOf(request);
    await this.#repository.purgeExpired(tx);
    const claimed = await this.#repository.claim(tx, {
      brandId: targetBrandId,
      apiKeyId: principal.id,
      key,
      requestHash,
    });

    if (claimed !== undefined) {
      const result = await lastValueFrom(next.handle(), { defaultValue: null });
      await this.#repository.complete(tx, claimed, JSON.stringify(result ?? null));
      return result;
    }

    const stored = await this.#repository.find(tx, principal.id, key);
    if (stored?.response == null) {
      throw new ConflictException('A request with this Idempotency-Key is still in progress');
    }
    if (stored.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'This Idempotency-Key was already used with a different request',
      );
    }
    reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    return JSON.parse(stored.response) as unknown;
  }
}
