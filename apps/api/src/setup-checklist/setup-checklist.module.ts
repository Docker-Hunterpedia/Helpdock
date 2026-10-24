import type { Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { AiRepository } from '../ai/ai.repository.js';
import { SETTINGS } from '../runtime/tokens.js';
import { SetupChecklistController } from './setup-checklist.controller.js';
import { SetupChecklistRepository } from './setup-checklist.repository.js';
import { SetupChecklistService } from './setup-checklist.service.js';

/**
 * M14-13: the Admin's setup checklist. The repositories are stateless (every
 * statement runs in the request's transaction), so a second `AiRepository` is
 * the same code and `AiModule` does not have to export its own.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class SetupChecklistModule {
  static forRoot(): DynamicModule {
    return {
      module: SetupChecklistModule,
      controllers: [SetupChecklistController],
      providers: [
        {
          provide: SetupChecklistService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): SetupChecklistService =>
            new SetupChecklistService(new SetupChecklistRepository(), new AiRepository(), settings),
        },
      ],
    };
  }
}
