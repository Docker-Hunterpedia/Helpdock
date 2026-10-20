import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiter } from '../auth/rate-limit.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { lexicalSource } from '../help-center/search/lexical.js';
import { HelpCenterSearchService } from '../help-center/search/search.service.js';
import { DB } from '../runtime/tokens.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { QuickSearchController } from './quick-search.controller.js';
import { QuickSearchService } from './quick-search.service.js';

/**
 * M14-05: the command palette's quick search. Owns no data: it reads through
 * the tickets, contacts and help-center services, each built once by
 * `AppModule` and imported here, as `ApiV1Module` does.
 */
export interface QuickSearchModuleOptions {
  readonly tickets: DynamicModule;
  readonly contacts: DynamicModule;
  readonly redis: Redis;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class QuickSearchModule {
  static forRoot({ tickets, contacts, redis }: QuickSearchModuleOptions): DynamicModule {
    return {
      module: QuickSearchModule,
      imports: [tickets, contacts],
      controllers: [QuickSearchController],
      providers: [
        {
          provide: QuickSearchService,
          inject: [TicketsService, ContactsService, DB],
          useFactory: (
            ticketsService: TicketsService,
            contactsService: ContactsService,
            db: Db,
          ): QuickSearchService =>
            new QuickSearchService(
              ticketsService,
              contactsService,
              // Full text only: the palette calls no model (ADR 0038), so no
              // embedding is made for a keystroke.
              new HelpCenterSearchService(db, { sources: [lexicalSource] }),
              new RateLimiter(redis),
            ),
        },
      ],
    };
  }
}
