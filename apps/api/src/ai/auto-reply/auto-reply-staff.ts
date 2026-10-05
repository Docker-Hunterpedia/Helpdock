import { auditLog, type DbTransaction, tickets } from '@helpdock/db';
import { type TicketAiState, ticketAiStateSchema } from '@helpdock/schemas';
import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createZodDto, ZodSerializerDto, ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';
import { requireStaffPrincipalId } from '../../auth/principal.js';
import { Requires } from '../../auth/route-declaration.js';
import { getTx, requireRequestContext } from '../../context/request-context.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../../tickets/ticket-events.js';
import { resumeAi, toTicketAiState } from './ai-pause.js';

/**
 * "Return to assistant" (M7-06, DOMAIN-RULES §9, `Admin/Ticket-AI`'s
 * AIPausedStrip): the one way a pause ends on an open conversation. Anyone
 * who may reply on the ticket may hand it back, as they could have taken it;
 * the ticket is read under their own department policy first, so a ticket
 * they cannot open is a 404. Audited, and a System event in the thread.
 */

class TicketParamDto extends createZodDto(z.object({ brandId: z.uuid(), ticketId: z.uuid() })) {}
class TicketAiStateDto extends createZodDto(ticketAiStateSchema) {}

@Injectable()
export class AutoReplyStaffService {
  async resume(
    tx: DbTransaction,
    { brandId, ticketId, actorId }: { brandId: string; ticketId: string; actorId: string },
  ): Promise<TicketAiState> {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.brandId, brandId)))
      .limit(1);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }
    const resumed = await resumeAi(tx, { brandId, ticketId, actorId });
    if (resumed === undefined) {
      return toTicketAiState(ticket);
    }
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId,
      action: 'ai.auto_reply.resumed',
      targetType: 'ticket',
      targetId: ticketId,
      meta: { pausedAt: ticket.aiPausedAt?.toISOString() ?? null, reason: ticket.aiPauseReason },
    });
    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
      ticketId,
      departmentId: resumed.departmentId,
    });
    return toTicketAiState(resumed);
  }
}

@Controller('api/brands/:brandId/tickets/:ticketId')
export class AutoReplyStaffController {
  readonly #service: AutoReplyStaffService;

  constructor(@Inject(AutoReplyStaffService) service: AutoReplyStaffService) {
    this.#service = service;
  }

  @Post('ai/resume')
  @Requires('ticket:write')
  @HttpCode(HttpStatus.OK)
  @ZodSerializerDto(TicketAiStateDto)
  resume(
    @Param(new ZodValidationPipe(TicketParamDto)) { brandId, ticketId }: TicketParamDto,
  ): Promise<TicketAiState> {
    return this.#service.resume(getTx(), {
      brandId,
      ticketId,
      actorId: requireStaffPrincipalId(requireRequestContext().principal),
    });
  }
}
