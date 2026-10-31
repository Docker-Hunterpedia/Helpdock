import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiter } from '../auth/rate-limit.js';
import { PresenceStore } from '../realtime/presence.store.js';
import { DB, ENV, REDIS, SETTINGS } from '../runtime/tokens.js';
import { InstallChannels } from './install-channels.js';
import { MentionCandidatesController } from './mention-candidates.controller.js';
import { MentionCandidatesService } from './mention-candidates.service.js';
import {
  NotificationPreferencesController,
  NotificationsController,
} from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService, TEST_EMAIL_LIMIT_PER_HOUR } from './notifications.service.js';
import { UnsubscribeController } from './unsubscribe.controller.js';
import { UnsubscribeService } from './unsubscribe.service.js';
import { UnsubscribeTokens } from './unsubscribe-tokens.js';

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
      controllers: [
        NotificationsController,
        NotificationPreferencesController,
        UnsubscribeController,
        MentionCandidatesController,
      ],
      providers: [
        {
          provide: NotificationsService,
          inject: [SETTINGS, REDIS],
          useFactory: (settings: Settings, redis: Redis): NotificationsService => {
            const limiter = new RateLimiter(redis);

            return new NotificationsService(
              new NotificationsRepository(),
              new InstallChannels(settings),
              {
                allow: (userId) =>
                  limiter.consume(
                    {
                      bucket: 'notify-test-email',
                      limit: TEST_EMAIL_LIMIT_PER_HOUR,
                      windowSeconds: 3600,
                    },
                    userId,
                  ),
              },
            );
          },
        },
        {
          // M14-15. Presence is read from M0-13's keys, as the assignee picker does.
          provide: MentionCandidatesService,
          inject: [REDIS],
          useFactory: (redis: Redis): MentionCandidatesService =>
            new MentionCandidatesService(new NotificationsRepository(), new PresenceStore(redis)),
        },
        {
          provide: UnsubscribeService,
          inject: [DB, ENV, REDIS],
          useFactory: (db: Db, env: Env, redis: Redis): UnsubscribeService =>
            new UnsubscribeService({
              db,
              repository: new NotificationsRepository(),
              tokens: new UnsubscribeTokens(createKeyring(env)),
              limiter: new RateLimiter(redis),
            }),
        },
      ],
    };
  }
}
