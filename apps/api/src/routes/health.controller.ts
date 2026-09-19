import type { Health, Readiness } from '@helpdock/schemas';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodSerializerDto } from 'nestjs-zod';
import { Public } from '../auth/route-declaration.js';
import { ReadinessService } from '../runtime/readiness.service.js';
import { HealthDto, ReadinessDto } from './dto.js';

/**
 * The liveness and readiness probes of ARCHITECTURE §14, which Compose and
 * Caddy call (M0-09). Both are `@Public()`: an orchestrator has no session, and
 * neither answer says anything a stranger could not learn by trying the port.
 */
@Controller()
export class HealthController {
  readonly #readiness: ReadinessService;

  constructor(@Inject(ReadinessService) readiness: ReadinessService) {
    this.#readiness = readiness;
  }

  /** Alive: the event loop is turning. It says nothing about dependencies. */
  @Get('health')
  @Public()
  @ZodSerializerDto(HealthDto)
  health(): Health {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Ready: the database, Redis and the settings resolver all answered. A 503
   * takes the replica out of rotation without killing it, which is what a
   * dependency blip deserves.
   */
  @Get('ready')
  @Public()
  @ZodSerializerDto(ReadinessDto)
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<Readiness> {
    const readiness = await this.#readiness.check();

    reply.status(readiness.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return readiness;
  }
}
