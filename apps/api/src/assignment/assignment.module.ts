import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PresenceStore } from '../realtime/presence.store.js';
import { REDIS } from '../runtime/tokens.js';
import { TagsService } from '../ticketing/tags.service.js';
import { AssignmentController } from './assignment.controller.js';
import { AssignmentRepository } from './assignment.repository.js';
import { AssignmentService } from './assignment.service.js';

export interface AssignmentModuleOptions {
  /** `TicketingModule.forRoot()`, built once by `AppModule`: skills are checked against its tags. */
  readonly ticketing: DynamicModule;
}

/**
 * M1-07's request half: the Assignment tab and the assignee picker.
 *
 * The rest of the deliverable is not here, deliberately. The rotation runs in
 * the worker (`assignment-events.ts`, registered by `worker/start-worker.ts`),
 * the offline timer is started by `RealtimeModule`'s `STAFF_OFFLINE_HOOK`, and
 * the ticket writes ask `ticket-assignment.ts` directly — none of which a
 * request to this module is involved in.
 *
 * Presence is read straight from M0-13's Redis keys through a `PresenceStore`
 * of this module's own: it is stateless over the connection, and importing
 * `RealtimeModule` for one read would tie the socket server's construction to
 * a settings screen.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class AssignmentModule {
  static forRoot({ ticketing }: AssignmentModuleOptions): DynamicModule {
    return {
      module: AssignmentModule,
      imports: [ticketing],
      controllers: [AssignmentController],
      providers: [
        { provide: AssignmentRepository, useFactory: () => new AssignmentRepository() },
        {
          provide: AssignmentService,
          inject: [AssignmentRepository, TagsService, REDIS],
          useFactory: (
            repository: AssignmentRepository,
            tags: TagsService,
            redis: Redis,
          ): AssignmentService => new AssignmentService(repository, tags, new PresenceStore(redis)),
        },
      ],
    };
  }
}
