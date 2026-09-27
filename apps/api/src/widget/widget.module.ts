import type { CaptchaTransport } from '@helpdock/channels';
import { createKeyring, type Env, type Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { WIDGET_EVENTS } from '@helpdock/schemas';
import {
  type DynamicModule,
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { RateLimiter } from '../auth/rate-limit.js';
import { CaptchaVerifier, DbCaptchaKeys, safeCaptchaTransport } from '../captcha/captcha-keys.js';
import { EmailRepository } from '../email/email.repository.js';
import { OutboundEmailService } from '../email/outbound-email.service.js';
import { SettingsInstallSmtp } from '../email/transport.js';
import type { Logger } from '../logging/logger.js';
import { MediaRepository } from '../media/media.repository.js';
import { MediaService } from '../media/media.service.js';
import { createS3Client, type ObjectStorage, S3ObjectStorage } from '../media/storage.js';
import { PresenceService } from '../realtime/presence.service.js';
import { RealtimePublisher } from '../realtime/publisher.js';
import { LOGGER, REDIS, SETTINGS } from '../runtime/tokens.js';
import { BusinessHoursService } from '../sla/business-hours.service.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { SlaLifecycleHooks } from '../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import { WidgetController } from './widget.controller.js';
import { WidgetGateway } from './widget.gateway.js';
import { WidgetRepository } from './widget.repository.js';
import { WidgetActivityService } from './widget-activity.service.js';
import { WidgetConfigService } from './widget-config.service.js';
import { WidgetConversationsService } from './widget-conversations.service.js';
import { WidgetGate } from './widget-gate.js';
import { WidgetHub } from './widget-hub.js';
import { brandVisitorsRoom, RedisWidgetBroadcast } from './widget-relay.js';
import { WidgetSessionService } from './widget-session.service.js';
import { WidgetSettingsController } from './widget-settings.controller.js';
import { WidgetSettingsRepository } from './widget-settings.repository.js';
import { WidgetSettingsService } from './widget-settings.service.js';
import {
  DEFAULT_STREAM_TIMINGS,
  WIDGET_STREAM_TIMINGS,
  WidgetStreamController,
  type WidgetStreamTimings,
} from './widget-stream.controller.js';
import { WidgetUploadsService } from './widget-uploads.service.js';

export interface WidgetModuleOptions {
  /** `AppModule`'s own `RealtimeModule`, so presence and the staff publisher are the ones it runs. */
  readonly realtime: DynamicModule;
  readonly env: Env;
  readonly db: Db;
  readonly logger: Logger;
  /** The bucket; a suite passes a double, boot builds one from `S3_*`. */
  readonly storage?: ObjectStorage;
  /** The siteverify call; a suite passes a recorder. */
  readonly captchaTransport?: CaptchaTransport;
  readonly streamTimings?: WidgetStreamTimings;
}

/**
 * Starts the hub's Redis subscription with the module and tells visitors when
 * a brand's agents come or go. A class of its own because Nest calls lifecycle
 * hooks on providers, and the hub is a plain object other providers share.
 */
class WidgetLifecycle implements OnModuleInit, OnModuleDestroy {
  readonly #hub: WidgetHub;
  readonly #presence: PresenceService;
  readonly #config: WidgetConfigService;
  readonly #broadcast: RedisWidgetBroadcast;
  readonly #logger: Logger;
  #unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(WidgetHub) hub: WidgetHub,
    @Inject(PresenceService) presence: PresenceService,
    @Inject(WidgetConfigService) config: WidgetConfigService,
    @Inject(REDIS) redis: Redis,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#hub = hub;
    this.#presence = presence;
    this.#config = config;
    this.#broadcast = new RedisWidgetBroadcast(redis);
    this.#logger = logger;
  }

  async onModuleInit(): Promise<void> {
    await this.#hub.start();
    this.#unsubscribe = this.#presence.onChange((brandId) => {
      void this.#config
        .agentsOnline(brandId)
        .then((agentsOnline) =>
          this.#broadcast.emit({
            room: brandVisitorsRoom(brandId),
            event: WIDGET_EVENTS.presence,
            data: { agentsOnline },
            seq: null,
          }),
        )
        .catch((error: unknown) => {
          this.#logger.warn({ err: error }, 'Could not tell visitors who is online');
        });
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.#unsubscribe?.();
    await this.#hub.stop();
  }
}

/**
 * M4-02, M4-03, M4-04, M4-06 to M4-08 in the api: the admin's Channels ›
 * Widget tab, the widget's REST routes, its SSE stream and the `/widget`
 * namespace. The worker's half is `widget-events.ts`.
 *
 * The services are plain classes built here, as `ChannelsModule` builds the
 * inbound pipeline: every one takes the transaction it is handed, and the
 * lifecycle is the one with M3's SLA hooks, so a widget conversation starts
 * and resumes its clocks exactly as a request would.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class WidgetModule {
  static forRoot(options: WidgetModuleOptions): DynamicModule {
    const { env, db, logger } = options;
    const keyring = createKeyring(env);
    const storage = options.storage ?? new S3ObjectStorage(createS3Client(env), env.S3_BUCKET);
    const settingsRepository = new WidgetSettingsRepository();
    const widget = new WidgetRepository();
    const tickets = new TicketRepository();
    const lifecycleReads = new TicketLifecycleRepository();
    const slaRepository = new SlaRepository();
    const media = new MediaRepository();
    const captchaKeys = new DbCaptchaKeys(db, keyring);
    const captcha = new CaptchaVerifier(
      captchaKeys,
      options.captchaTransport ?? safeCaptchaTransport(env.OUTBOUND_ALLOW_CIDRS),
    );

    return {
      module: WidgetModule,
      imports: [options.realtime],
      controllers: [WidgetSettingsController, WidgetController, WidgetStreamController],
      providers: [
        {
          provide: WidgetSettingsService,
          useFactory: () => new WidgetSettingsService(settingsRepository, keyring),
        },
        {
          provide: WidgetGate,
          inject: [REDIS],
          useFactory: (redis: Redis) =>
            new WidgetGate({
              db,
              settings: settingsRepository,
              widget,
              limiter: new RateLimiter(redis),
            }),
        },
        {
          provide: WidgetHub,
          inject: [REDIS],
          useFactory: (redis: Redis) => new WidgetHub(redis, logger),
        },
        {
          provide: WidgetConfigService,
          inject: [WidgetGate, PresenceService],
          useFactory: (gate: WidgetGate, presence: PresenceService) =>
            new WidgetConfigService({
              gate,
              businessHours: new BusinessHoursService(slaRepository, new SlaService(slaRepository)),
              presence,
              captcha: captchaKeys,
            }),
        },
        {
          provide: WidgetSessionService,
          inject: [WidgetGate],
          useFactory: (gate: WidgetGate) =>
            new WidgetSessionService({ gate, widget, keyring, logger }),
        },
        {
          provide: WidgetConversationsService,
          inject: [WidgetGate],
          useFactory: (gate: WidgetGate) =>
            new WidgetConversationsService({
              gate,
              widget,
              tickets,
              lifecycle: new TicketLifecycleService(
                lifecycleReads,
                tickets,
                new SlaLifecycleHooks(lifecycleReads, new SlaService(slaRepository)),
              ),
              lifecycleReads,
              assignment: new AssignmentRepository(),
              media,
              captcha,
            }),
        },
        {
          provide: WidgetActivityService,
          inject: [WidgetGate, WidgetConversationsService, RealtimePublisher, SETTINGS, REDIS],
          useFactory: (
            gate: WidgetGate,
            conversations: WidgetConversationsService,
            publisher: RealtimePublisher,
            settings: Settings,
            redis: Redis,
          ) =>
            new WidgetActivityService({
              gate,
              conversations,
              publisher,
              outbound: new OutboundEmailService(
                new EmailRepository(),
                new SettingsInstallSmtp(settings),
              ),
              lifecycleReads,
              limiter: new RateLimiter(redis),
            }),
        },
        {
          provide: WidgetUploadsService,
          inject: [WidgetGate, WidgetConversationsService],
          useFactory: (gate: WidgetGate, conversations: WidgetConversationsService) =>
            new WidgetUploadsService({
              gate,
              conversations,
              media: new MediaService(media, storage),
              attachments: media,
              widget,
            }),
        },
        {
          provide: WIDGET_STREAM_TIMINGS,
          useValue: options.streamTimings ?? DEFAULT_STREAM_TIMINGS,
        },
        { provide: LOGGER, useValue: logger },
        WidgetLifecycle,
        WidgetGateway,
      ],
    };
  }
}
