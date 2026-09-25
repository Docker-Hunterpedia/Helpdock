import { type DynamicModule, Module } from '@nestjs/common';
import { TicketRepository } from '../tickets/tickets.repository.js';
import { ViewsController } from './views.controller.js';
import { ViewsRepository } from './views.repository.js';
import { ViewsService } from './views.service.js';

/**
 * M1-05: saved views and their counts.
 *
 * The counts are read through a `TicketRepository` of its own. It is
 * stateless — every statement runs in the request's transaction — so a second
 * instance is the same code, and it keeps `TicketsModule` from exporting its
 * repository to every module that wants a `WHERE`.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ViewsModule {
  static forRoot(): DynamicModule {
    return {
      module: ViewsModule,
      controllers: [ViewsController],
      providers: [
        {
          provide: ViewsService,
          useFactory: (): ViewsService =>
            new ViewsService(new ViewsRepository(), new TicketRepository()),
        },
      ],
    };
  }
}
