import type { Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { SETTINGS } from '../runtime/tokens.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsRepository } from './contacts.repository.js';
import { ContactsService } from './contacts.service.js';
import {
  CONTACT_TIMELINE_PROVIDER,
  type ContactTimelineProvider,
  NoContactTimelineProvider,
  NoTicketStatsProvider,
  TICKET_STATS_PROVIDER,
  type TicketStatsProvider,
} from './providers.js';

/**
 * M1-04: contacts, accounts, identifiers, notes and duplicate suggestions.
 *
 * One module for two controllers that share one repository, so `app.module.ts`
 * gains one import and the rules about who a person is live in one folder.
 *
 * The two providers are the seam to tickets. They default to the "none yet"
 * implementations; M1-02 passes real ones here and nothing else in this folder
 * changes.
 */

export interface ContactsModuleOptions {
  /** Defaults to {@link NoTicketStatsProvider}; M1-02 supplies the real one. */
  readonly ticketStats?: TicketStatsProvider;
  /** Defaults to {@link NoContactTimelineProvider}; M1-02 supplies the real one. */
  readonly timeline?: ContactTimelineProvider;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ContactsModule {
  static forRoot({ ticketStats, timeline }: ContactsModuleOptions = {}): DynamicModule {
    return {
      module: ContactsModule,
      controllers: [ContactsController, AccountsController],
      providers: [
        {
          provide: ContactsRepository,
          useFactory: (): ContactsRepository => new ContactsRepository(),
        },
        { provide: TICKET_STATS_PROVIDER, useValue: ticketStats ?? new NoTicketStatsProvider() },
        {
          provide: CONTACT_TIMELINE_PROVIDER,
          useValue: timeline ?? new NoContactTimelineProvider(),
        },
        {
          provide: ContactsService,
          inject: [ContactsRepository, SETTINGS, TICKET_STATS_PROVIDER, CONTACT_TIMELINE_PROVIDER],
          useFactory: (
            repository: ContactsRepository,
            settings: Settings,
            stats: TicketStatsProvider,
            contactTimeline: ContactTimelineProvider,
          ): ContactsService =>
            new ContactsService({ repository, settings, stats, timeline: contactTimeline }),
        },
        {
          provide: AccountsService,
          inject: [ContactsRepository],
          useFactory: (repository: ContactsRepository): AccountsService =>
            new AccountsService({ repository }),
        },
      ],
    };
  }
}
