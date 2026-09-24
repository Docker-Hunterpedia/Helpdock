import { type DynamicModule, Module } from '@nestjs/common';
import { ParticipantsController } from './participants.controller.js';
import { ParticipantsRepository } from './participants.repository.js';
import { TicketParticipantsService } from './ticket-participants.service.js';

/**
 * M1-13: a ticket's participants — its contact, its CCs and its staff
 * (DOMAIN-RULES §2.5).
 *
 * `TicketParticipantsService` is exported because two other paths copy a
 * contact in by id through `addCcParticipant`: M1-09's ticket merge, which adds
 * the secondary's contact as a CC (§2.4), and M2's inbound `Cc:` line. A module
 * that needs it imports this one rather than building a second instance.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ParticipantsModule {
  static forRoot(): DynamicModule {
    return {
      module: ParticipantsModule,
      controllers: [ParticipantsController],
      providers: [
        {
          provide: ParticipantsRepository,
          useFactory: (): ParticipantsRepository => new ParticipantsRepository(),
        },
        {
          provide: TicketParticipantsService,
          inject: [ParticipantsRepository],
          useFactory: (repository: ParticipantsRepository): TicketParticipantsService =>
            new TicketParticipantsService(repository),
        },
      ],
      exports: [TicketParticipantsService],
    };
  }
}
