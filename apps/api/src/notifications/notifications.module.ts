import type { Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { SETTINGS } from '../runtime/tokens.js';
import { InstallChannels } from './install-channels.js';
import {
  NotificationPreferencesController,
  NotificationsController,
} from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/**
 * M3-07's request half: the bell's panel and the Notifications tab. The
 * fan-out and delivery run in the worker (`notification-events.ts`,
 * `delivery.ts`) and are wired by `worker/start-worker.ts`, because
 * `APP_ROLE=api` runs no queue.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class NotificationsModule {
  static forRoot(): DynamicModule {
    return {
      module: NotificationsModule,
      controllers: [NotificationsController, NotificationPreferencesController],
      providers: [
        {
          provide: NotificationsService,
          inject: [SETTINGS],
          useFactory: (settings: Settings): NotificationsService =>
            new NotificationsService(new NotificationsRepository(), new InstallChannels(settings)),
        },
      ],
    };
  }
}
