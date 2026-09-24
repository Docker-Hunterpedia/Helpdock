import { type DynamicModule, Module } from '@nestjs/common';
import { MediaRepository } from '../media/media.repository.js';
import { TagsService } from '../ticketing/tags.service.js';
import { TemplatesService } from '../ticketing/templates.service.js';
import { TicketLifecycleHooks } from './lifecycle/hooks.js';
import { TicketLifecycleRepository } from './lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from './lifecycle/lifecycle.service.js';
import { TicketingSettingsController } from './lifecycle/ticketing-settings.controller.js';
import { TicketingSettingsService } from './lifecycle/ticketing-settings.service.js';
import { MergeController } from './merge/merge.controller.js';
import { MergeRepository } from './merge/merge.repository.js';
import { MergeService } from './merge/merge.service.js';
import { MergeParticipantsHook } from './merge/participants.hook.js';
import { TicketsController } from './tickets.controller.js';
import { TicketRepository } from './tickets.repository.js';
import { TicketsService } from './tickets.service.js';

/**
 * M1-02 and M1-03 in one import: the ticket, its thread, its activity log.
 *
 * Almost nothing is passed in. Unlike `StaffModule` and `RealtimeModule`, which
 * are handed things boot built before Nest existed, every dependency here is
 * either a provider of this module, the request transaction — which `getTx()`
 * reaches through the `AsyncLocalStorage` the interceptor filled — or, from
 * M1-06, the ticketing module.
 *
 * `ticketing` is the **already-built** `TicketingModule.forRoot()`, for the
 * reason `AppModule` builds `AuthModule.forRoot()` once and imports it twice: a
 * second call would be a second module to Nest, and its controllers would be
 * registered twice.
 *
 * The realtime half is deliberately *not* here. A ticket change reaches a
 * socket through the outbox and a worker
 * ({@link ./ticket-events.js ticket-events.ts}), never by this module emitting,
 * because a side effect enqueued outside the transaction can drift from the
 * change that caused it (DOMAIN-RULES §6).
 */

export interface TicketsModuleOptions {
  /** `TicketingModule.forRoot()`, built once by `AppModule` and imported twice. */
  readonly ticketing: DynamicModule;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class TicketsModule {
  static forRoot({ ticketing }: TicketsModuleOptions): DynamicModule {
    return {
      module: TicketsModule,
      imports: [ticketing],
      controllers: [TicketsController, TicketingSettingsController, MergeController],
      providers: [
        TicketRepository,
        {
          provide: TicketsService,
          inject: [
            TicketRepository,
            TicketLifecycleService,
            TicketLifecycleRepository,
            MediaRepository,
            TemplatesService,
            TagsService,
          ],
          useFactory: (
            tickets: TicketRepository,
            lifecycle: TicketLifecycleService,
            lifecycleReads: TicketLifecycleRepository,
            attachments: MediaRepository,
            templates: TemplatesService,
            tags: TagsService,
          ): TicketsService =>
            new TicketsService(tickets, lifecycle, lifecycleReads, attachments, templates, tags),
        },
        // M1-08. `TicketLifecycleHooks` is a provider rather than a registry so
        // that M3-02's clocks and M1-12's survey replace one line here instead
        // of editing the service that calls them (`lifecycle/hooks.ts`).
        TicketLifecycleHooks,
        TicketLifecycleRepository,
        TicketLifecycleService,
        TicketingSettingsService,
        // M1-10. `MediaRepository` is listed rather than imported from
        // `MediaModule`: it is stateless — every method takes the request's
        // transaction — so a second instance costs nothing, and importing a
        // dynamic module for one stateless class would tie the two modules'
        // construction together.
        MediaRepository,
        // M1-09. `MergeParticipantsHook` is the seam M1-13 fills: a provider,
        // for the reason `TicketLifecycleHooks` is one, so participants replace
        // one line here rather than editing the merge.
        MergeRepository,
        MergeParticipantsHook,
        MergeService,
      ],
    };
  }
}
