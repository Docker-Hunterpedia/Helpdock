import type { InboundPayload, InboundUpload } from '@helpdock/channels';
import {
  INBOUND_PARSE_SECRET_HEADER,
  type InboundParseOutcome,
  inboundParseProviderParamSchema,
} from '@helpdock/schemas';
import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import type { z } from 'zod';
import { Public } from '../../auth/route-declaration.js';
import { createIpRateLimiter } from '../../routes/ip-rate-limit.js';
import { InboundParseService } from './inbound-parse.service.js';

/**
 * The inbound-parse endpoints of M2-03. `@Public()` because a provider has no
 * session; the brand's shared secret is the credential, and
 * {@link InboundParseService} checks it once the recipient has named the brand.
 *
 * JSON arrives parsed by Fastify, and so does a url-encoded form. A multipart
 * body — SendGrid's and Mailgun's — arrives as the raw bytes
 * `inbound-parse-body.ts` hands over, and is decoded here with the platform's
 * own `FormData` parser.
 */
@Controller('internal/inbound-parse')
export class InboundParseController {
  /**
   * Generous: one provider may deliver a burst of a mailing thread at once.
   * It bounds a stranger hammering the endpoint without a secret, not a
   * provider doing its job.
   */
  readonly #limiter = createIpRateLimiter({ limit: 600, windowMs: 60_000, maxTrackedIps: 4096 });
  readonly #inbound: InboundParseService;

  constructor(@Inject(InboundParseService) inbound: InboundParseService) {
    this.#inbound = inbound;
  }

  @Post(':provider')
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param(new ZodValidationPipe(inboundParseProviderParamSchema))
    { provider }: z.infer<typeof inboundParseProviderParamSchema>,
    @Req() request: FastifyRequest,
  ): Promise<{ outcome: InboundParseOutcome }> {
    if (!this.#limiter.allow(request.ip)) {
      throw new HttpException('Too many inbound-parse requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const secretHeader = request.headers[INBOUND_PARSE_SECRET_HEADER];

    return this.#inbound.receive({
      provider,
      payload: await payloadOf(request),
      secretHeader: typeof secretHeader === 'string' ? secretHeader : undefined,
      authorization: request.headers.authorization,
    });
  }
}

const payloadOf = async (request: FastifyRequest): Promise<InboundPayload> => {
  const body: unknown = request.body;
  const contentType = request.headers['content-type'] ?? '';
  if (/^application\/x-www-form-urlencoded/i.test(contentType)) {
    const fields = new Map<string, string>();
    for (const [name, value] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      fields.set(name, Array.isArray(value) ? String(value[0]) : String(value));
    }
    return { kind: 'form', fields, files: new Map() };
  }
  if (!Buffer.isBuffer(body)) {
    return { kind: 'json', body };
  }

  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    throw new BadRequestException('The form body could not be read');
  }

  const fields = new Map<string, string>();
  const files = new Map<string, InboundUpload>();
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      fields.set(name, value);
    } else {
      files.set(name, {
        filename: value.name,
        contentType: value.type || 'application/octet-stream',
        content: Buffer.from(await value.arrayBuffer()),
      });
    }
  }

  return { kind: 'form', fields, files };
};
