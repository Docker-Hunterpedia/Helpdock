import { type DynamicModule, Module } from '@nestjs/common';
import { CsatService } from '../csat/csat.service.js';
import { CsatLifecycleHooks } from '../csat/csat-hooks.js';
import { MediaRepository } from '../media/media.repository.js';
import { TagsService } from '../ticketing/tags.service.js';
import { TemplatesService } from '../ticketing/templates.service.js';
import { TicketLifecycleHooks } from './lifecycle/hooks.js';
import { TicketLifecycleRepository } from './lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from './lifecycle/lifecycle.service.js';
import { TicketingSettingsController } from './lifecycle/ticketing-settings.controller.js';
import { TicketingSettingsService } from './lifecycle/ticketing-settings.service.js';
import { TicketsController } from './tickets.controller.js';
import { TicketRepository } from './tickets.repository.js';
import { TicketsService } from './tickets.service.js';
import { TimeEntriesController } from './time/time-entries.controller.js';
import { TimeEntriesRepository } from './time/time-entries.repository.js';
import { TimeEntriesService } from './time/time-entries.service.js';

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
  /** `CsatModule.forRoot()` (M1-12), built once and imported twice for the same reason. */
  readonly csat: DynamicModule;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class TicketsModule {
  static forRoot({ ticketing, csat }: TicketsModuleOptions): DynamicModule {
    return {
      module: TicketsModule,
      imports: [ticketing, csat],
      controllers: [TicketsController, TicketingSettingsController, TimeEntriesController],
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
            CsatService,
            TimeEntriesService,
          ],
          useFactory: (
            tickets: TicketRepository,
            lifecycle: TicketLifecycleService,
            lifecycleReads: TicketLifecycleRepository,
            attachments: MediaRepository,
            templates: TemplatesService,
            tags: TagsService,
            csatSummary: CsatService,
            timeEntries: TimeEntriesService,
          ): TicketsService =>
            new TicketsService(
              tickets,
              lifecycle,
              lifecycleReads,
              attachments,
              templates,
              tags,
              csatSummary,
              timeEntries,
            ),
        },
        // M1-08. `TicketLifecycleHooks` is a provider rather than a registry so
        // that M3-02's clocks and M1-12's survey replace one line here instead
        // of editing the service that calls them (`lifecycle/hooks.ts`). This is
        // M1-12's line: the survey hook, which inherits the other two.
        { provide: TicketLifecycleHooks, useClass: CsatLifecycleHooks },
        TicketLifecycleRepository,
        TicketLifecycleService,
        TicketingSettingsService,
        // M1-12's Time card.
        TimeEntriesRepository,
        TimeEntriesService,
        // M1-10. `MediaRepository` is listed rather than imported from
        // `MediaModule`: it is stateless — every method takes the request's
        // transaction — so a second instance costs nothing, and importing a
        // dynamic module for one stateless class would tie the two modules'
        // construction together.
        MediaRepository,
      ],
    };
  }
}
