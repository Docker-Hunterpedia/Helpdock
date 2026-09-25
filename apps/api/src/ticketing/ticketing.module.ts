import { type DynamicModule, Module } from '@nestjs/common';
import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsRepository } from './custom-fields.repository.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { TagsController } from './tags.controller.js';
import { TagsRepository } from './tags.repository.js';
import { TagsService } from './tags.service.js';
import { TemplatesController } from './templates.controller.js';
import { TemplatesRepository } from './templates.repository.js';
import { TemplatesService } from './templates.service.js';
import { TicketTagsController } from './ticket-tags.controller.js';
import { TicketTagsService } from './ticket-tags.service.js';

/**
 * M1-06 in one import: tags, custom field definitions and ticket templates —
 * the three remaining tabs of the Ticketing settings screen — plus the tags on
 * a ticket, which is what an agent actually does with them.
 *
 * The services are wired by hand, as `BrandsModule` wires its own: every
 * dependency is either a provider of this module or the request transaction,
 * which `getTx()` reaches through the `AsyncLocalStorage` the tenant
 * interceptor filled. Nothing here is passed in from boot.
 *
 * `TemplatesService` and `TicketTagsService` both take `TagsService`, because
 * both have to answer "is this id one of this brand's tags?" and a second
 * spelling of that would be a second answer.
 *
 * The realtime half is deliberately absent, as it is in `TicketsModule`: a tag
 * change reaches a socket through the outbox and a worker, never by this module
 * emitting (DOMAIN-RULES §6).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class TicketingModule {
  static forRoot(): DynamicModule {
    return {
      module: TicketingModule,
      controllers: [
        TagsController,
        CustomFieldsController,
        TemplatesController,
        TicketTagsController,
      ],
      providers: [
        { provide: TagsRepository, useFactory: (): TagsRepository => new TagsRepository() },
        {
          provide: CustomFieldsRepository,
          useFactory: (): CustomFieldsRepository => new CustomFieldsRepository(),
        },
        {
          provide: TemplatesRepository,
          useFactory: (): TemplatesRepository => new TemplatesRepository(),
        },
        {
          provide: TagsService,
          inject: [TagsRepository],
          useFactory: (repository: TagsRepository): TagsService => new TagsService(repository),
        },
        {
          provide: CustomFieldsService,
          inject: [CustomFieldsRepository],
          useFactory: (repository: CustomFieldsRepository): CustomFieldsService =>
            new CustomFieldsService(repository),
        },
        {
          provide: TemplatesService,
          inject: [TemplatesRepository, TagsService],
          useFactory: (repository: TemplatesRepository, tags: TagsService): TemplatesService =>
            new TemplatesService(repository, tags),
        },
        {
          provide: TicketTagsService,
          inject: [TagsService],
          useFactory: (tags: TagsService): TicketTagsService => new TicketTagsService(tags),
        },
      ],
      // `TicketsModule` applies a template and validates custom values on
      // creation, so it needs these two. Exported rather than duplicated, for
      // the reason the module comment gives.
      exports: [TemplatesService, TagsService],
    };
  }
}
