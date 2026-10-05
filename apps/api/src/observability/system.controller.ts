import type {
  ProductMetrics,
  QueueBoardPass,
  SystemQueuePage,
  SystemQueuesQuery,
  SystemStatus,
} from '@helpdock/schemas';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { requireStaffPrincipalId } from '../auth/principal.js';
import { Requires } from '../auth/route-declaration.js';
import { bearerTokenOf, verifyAccessToken } from '../auth/session/access-token.js';
import type { SigningKeys } from '../auth/session/signing-keys.js';
import { requireRequestContext } from '../context/request-context.js';
import {
  ProductMetricsDto,
  QueueBoardPassDto,
  SystemQueuePageDto,
  SystemQueuesQueryDto,
  SystemStatusDto,
} from '../routes/dto.js';
import { QueueBoardAccess } from './queue-board.js';
import { SystemService } from './system.service.js';
import { OBSERVABILITY_SIGNING_KEYS } from './tokens.js';

/**
 * The System page's data (REQUIREMENTS §4.10).
 *
 * `@Requires('install:admin')` rather than `'system:read'`: everything here is
 * install-wide — the schema, the queues, the runtime database role, the audit
 * log — and a brand's Admin has no business reading another brand's
 * infrastructure. The route therefore runs in install scope and the tenant
 * interceptor writes an `install.scope.access` audit row before the handler
 * sees the transaction (ARCHITECTURE §6).
 */
@Controller('api')
export class SystemController {
  readonly #system: SystemService;
  readonly #board: QueueBoardAccess;
  readonly #keys: SigningKeys;

  constructor(
    @Inject(SystemService) system: SystemService,
    @Inject(QueueBoardAccess) board: QueueBoardAccess,
    @Inject(OBSERVABILITY_SIGNING_KEYS) keys: SigningKeys,
  ) {
    this.#system = system;
    this.#board = board;
    this.#keys = keys;
  }

  @Get('install/system')
  @Requires('install:admin')
  @ZodSerializerDto(SystemStatusDto)
  async status(): Promise<SystemStatus> {
    return this.#system.status();
  }

  /**
   * Every queue, paginated. The status read carries the first few so one
   * request draws the page; this is what "All queues" asks for.
   *
   * The pipe is constructed with the DTO rather than left to the global one.
   * The global pipe finds the schema through the parameter's *design-time
   * type*, which only exists if the DTO is imported as a value — and a
   * parameter that is otherwise used only as a type annotation is something the
   * formatter is free to rewrite to `import type`, silently erasing the class
   * and with it the validation. Naming the DTO here is a use that cannot be
   * erased (`apps/api/README.md`, "Adding a route").
   */
  /** DOMAIN-RULES §15's product metrics (M8-07): activation, self-service, AI deflection. */
  @Get('install/system/metrics')
  @Requires('install:admin')
  @ZodSerializerDto(ProductMetricsDto)
  async productMetrics(): Promise<ProductMetrics> {
    return this.#system.productMetrics();
  }

  /**
   * "Open queue dashboard" (M8-05): a one-minute, one-use address that opens
   * Bull Board in a new tab (`queue-board.ts`). It follows the admin's
   * browser session — the refresh family the bearer token names — so it is
   * refused to a principal that is not one.
   */
  @Post('install/system/queue-board')
  @HttpCode(HttpStatus.OK)
  @Requires('install:admin')
  @ZodSerializerDto(QueueBoardPassDto)
  async queueBoard(@Req() request: FastifyRequest): Promise<QueueBoardPass> {
    const claims = await verifyAccessToken(
      bearerTokenOf(request.headers.authorization) ?? '',
      this.#keys,
    );
    if (claims === null) {
      throw new ForbiddenException('The queue dashboard is opened from a signed-in admin session');
    }
    const userId = requireStaffPrincipalId(requireRequestContext().principal);

    return { url: await this.#board.issuePass({ userId, familyId: claims.fam }) };
  }

  @Get('install/system/queues')
  @Requires('install:admin')
  @ZodSerializerDto(SystemQueuePageDto)
  async queues(
    @Query(new ZodValidationPipe(SystemQueuesQueryDto)) query: SystemQueuesQuery,
  ): Promise<SystemQueuePage> {
    return this.#system.queuePage(query);
  }
}
