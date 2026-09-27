import { type DynamicModule, Module } from '@nestjs/common';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { TemplatesRepository } from '../ticketing/templates.repository.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { CannedResponsesService } from './canned-responses.service.js';
import { MacroRunService } from './macro-run.service.js';
import { MacrosController } from './macros.controller.js';
import { MacrosRepository } from './macros.repository.js';
import { MacrosService } from './macros.service.js';

export interface MacrosModuleOptions {
  /**
   * `TicketsModule.forRoot()`, built once by `AppModule` and imported twice, for
   * the reason `ticketing` is: applying a macro replies and edits through the
   * very `TicketsService` a person's own reply and edit go through.
   */
  readonly tickets: DynamicModule;
}

/**
 * M3-06: macros and canned responses, the render seam M3-03's rules call, and
 * applying one to a ticket.
 *
 * The repositories are built here rather than imported: they are stateless —
 * every method takes the transaction — as `ViewsModule` does with its own.
 * `CannedResponsesService` is exported for the rules engine.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class MacrosModule {
  static forRoot({ tickets }: MacrosModuleOptions): DynamicModule {
    const repository = new MacrosRepository();

    return {
      module: MacrosModule,
      imports: [tickets],
      controllers: [MacrosController],
      providers: [
        { provide: MacrosService, useFactory: () => new MacrosService(repository) },
        {
          provide: CannedResponsesService,
          useFactory: () => new CannedResponsesService(repository, new TemplatesRepository()),
        },
        {
          provide: MacroRunService,
          inject: [TicketsService],
          useFactory: (ticketsService: TicketsService) =>
            new MacroRunService(repository, ticketsService, new AssignmentRepository()),
        },
      ],
      exports: [CannedResponsesService],
    };
  }
}
