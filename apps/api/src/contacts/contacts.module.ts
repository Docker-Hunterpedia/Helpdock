import type { Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { SETTINGS } from '../runtime/tokens.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { ContactMergeService } from './contact-merge.service.js';
import { ContactMergesController } from './contact-merges.controller.js';
import { ContactMergesRepository } from './contact-merges.repository.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsRepository } from './contacts.repository.js';
import { ContactsService } from './contacts.service.js';
import {
  CONTACT_ERASURE_PROVIDER,
  CONTACT_TIMELINE_PROVIDER,
  type ContactErasureProvider,
  type ContactTimelineProvider,
  NoContactErasureProvider,
  NoContactTimelineProvider,
  NoTicketStatsProvider,
  TICKET_STATS_PROVIDER,
  type TicketStatsProvider,
} from './providers.js';

/**
 * M1-04: contacts, accounts, identifiers, notes and duplicate suggestions; M1-13
 * adds merging two contacts and its undo.
 *
 * One module for two controllers that share one repository, so `app.module.ts`
 * gains one import and the rules about who a person is live in one folder.
 *
 * The providers are the seam to tickets. They default to the "none yet"
 * implementations; M1-02 passes the stats and the timeline here, and M1-14 the
 * erasure of the traces a contact left on tickets.
 */

export interface ContactsModuleOptions {
  /** Defaults to {@link NoTicketStatsProvider}; M1-02 supplies the real one. */
  readonly ticketStats?: TicketStatsProvider;
  /** Defaults to {@link NoContactTimelineProvider}; M1-02 supplies the real one. */
  readonly timeline?: ContactTimelineProvider;
  /** Defaults to {@link NoContactErasureProvider}; M1-14 supplies the real one. */
  readonly erasure?: ContactErasureProvider;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ContactsModule {
  static forRoot({ ticketStats, timeline, erasure }: ContactsModuleOptions = {}): DynamicModule {
    return {
      module: ContactsModule,
      controllers: [ContactsController, AccountsController, ContactMergesController],
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
        { provide: CONTACT_ERASURE_PROVIDER, useValue: erasure ?? new NoContactErasureProvider() },
        {
          provide: ContactMergesRepository,
          useFactory: (): ContactMergesRepository => new ContactMergesRepository(),
        },
        {
          provide: ContactsService,
          inject: [
            ContactsRepository,
            ContactMergesRepository,
            SETTINGS,
            TICKET_STATS_PROVIDER,
            CONTACT_TIMELINE_PROVIDER,
            CONTACT_ERASURE_PROVIDER,
          ],
          useFactory: (
            repository: ContactsRepository,
            merges: ContactMergesRepository,
            settings: Settings,
            stats: TicketStatsProvider,
            contactTimeline: ContactTimelineProvider,
            contactErasure: ContactErasureProvider,
          ): ContactsService =>
            new ContactsService({
              repository,
              merges,
              settings,
              stats,
              timeline: contactTimeline,
              erasure: contactErasure,
            }),
        },
        // M1-13. The survivor's detail is what a merge answers with, so the
        // merge service borrows `detail` rather than drawing a contact twice.
        {
          provide: ContactMergeService,
          inject: [ContactMergesRepository, ContactsRepository, ContactsService],
          useFactory: (
            merges: ContactMergesRepository,
            contacts: ContactsRepository,
            detail: ContactsService,
          ): ContactMergeService => new ContactMergeService({ merges, contacts, detail }),
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
