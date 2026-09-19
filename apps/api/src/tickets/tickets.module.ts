import { type DynamicModule, Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller.js';
import { TicketRepository } from './tickets.repository.js';
import { TicketsService } from './tickets.service.js';

/**
 * M1-02 and M1-03 in one import: the ticket, its thread, its activity log.
 *
 * Nothing is passed in. Unlike `StaffModule` and `RealtimeModule`, which are
 * handed things boot built before Nest existed, every dependency here is either
 * a provider of this module or the request transaction, which `getTx()` reaches
 * through the `AsyncLocalStorage` the interceptor filled.
 *
 * The realtime half is deliberately *not* here. A ticket change reaches a
 * socket through the outbox and a worker
 * ({@link ./ticket-events.js ticket-events.ts}), never by this module emitting,
 * because a side effect enqueued outside the transaction can drift from the
 * change that caused it (DOMAIN-RULES §6).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class TicketsModule {
  static forRoot(): DynamicModule {
    return {
      module: TicketsModule,
      controllers: [TicketsController],
      providers: [TicketRepository, TicketsService],
    };
  }
}
