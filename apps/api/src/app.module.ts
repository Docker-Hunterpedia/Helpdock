import type { Env, Settings } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { AssignmentModule } from './assignment/assignment.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule, type AuthModuleOptions } from './auth/auth.module.js';
import { PermissionGuard } from './auth/permission.guard.js';
import type { PrincipalResolver } from './auth/principal-resolver.js';
import { BrandsModule } from './brands/brands.module.js';
import { ContactsModule } from './contacts/contacts.module.js';
import type { BrandResolver } from './context/brand-resolver.js';
import { NoopBrandResolver } from './context/brand-resolver.js';
import { RequestContextMiddleware } from './context/request-context.middleware.js';
import { AllExceptionsFilter } from './http/exception.filter.js';
import { InstallModule } from './install/install.module.js';
import type { Logger } from './logging/logger.js';
import { MediaModule } from './media/media.module.js';
import type { ObjectStorage } from './media/storage.js';
import type { BootFacts } from './observability/boot-facts.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { ParticipantsModule } from './participants/participants.module.js';
import { RealtimeModule, type RealtimeModuleOptions } from './realtime/realtime.module.js';
import { DbContactErasureProvider } from './retention/contact-erasure.js';
import { RetentionModule } from './retention/retention.module.js';
import { DomainCheckController } from './routes/domain-check.controller.js';
import { DomainCheckService } from './routes/domain-check.service.js';
import { HealthController } from './routes/health.controller.js';
import { MeController } from './routes/me.controller.js';
import { ConfigModule } from './runtime/config.module.js';
import { DbModule } from './runtime/db.module.js';
import { SettingsModule } from './runtime/settings.module.js';
import { BRAND_RESOLVER, LOGGER, PRINCIPAL_RESOLVER } from './runtime/tokens.js';
import { StaffModule } from './staff/staff.module.js';
import { StaticModule } from './static/static.module.js';
import { TenantInterceptor } from './tenant/tenant.interceptor.js';
import { TicketingModule } from './ticketing/ticketing.module.js';
import { DbContactTimelineProvider, DbTicketStatsProvider } from './tickets/contact-providers.js';
import { TicketsModule } from './tickets/tickets.module.js';

/**
 * The request lifecycle of ARCHITECTURE §6, in the order Nest runs it:
 *
 * 1. `RequestContextMiddleware` — request id, host brand, AsyncLocalStorage.
 * 2. `AuthGuard` — the principal, or 401.
 * 3. `PermissionGuard` — `@Requires`, the target brand, the tenant scope, or 403.
 * 4. `ZodSerializerInterceptor` — the response's output schema, outside the
 *    transaction so parsing does not hold a connection.
 * 5. `TenantInterceptor` — the transaction with the `app.*` settings.
 * 6. `ZodValidationPipe` — the request's input schemas.
 * 7. `AllExceptionsFilter` — one body shape for every failure.
 *
 * Global guards run in the order they are registered, and global interceptors
 * nest in that order too: the first registered is the outermost.
 */

export interface AppModuleOptions {
  readonly env: Env;
  readonly db: Db;
  readonly settings: Settings;
  readonly redis: Redis;
  readonly logger: Logger;
  /** What boot learned about the database role and the schema; the System page reports it. */
  readonly bootFacts: BootFacts;
  readonly principalResolver: PrincipalResolver;
  /** Everything under `/api/auth` (M0-05); boot supplies the signing keys. */
  readonly auth: AuthModuleOptions;
  /**
   * The `/staff` namespace and presence (M0-13). The logger is filled in from
   * {@link AppModuleOptions.logger}, so a caller only names what is its own.
   */
  readonly realtime: Omit<RealtimeModuleOptions, 'logger'>;
  /** Defaults to {@link NoopBrandResolver}; M5 supplies the real one. */
  readonly brandResolver?: BrandResolver;
  /**
   * The bucket M1-10's attachment routes presign against. Boot leaves it out
   * and `MediaModule` builds an S3 client from the bootstrap keys; a suite
   * passes a double so the routes can be exercised without one.
   */
  readonly objectStorage?: ObjectStorage;
  /** Controllers a test mounts alongside the real ones. Empty in production. */
  readonly extraControllers?: readonly Type<unknown>[];
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    // Built once and imported twice, by `AppModule` and by `InstallModule`:
    // the same object is one module to Nest, so the wizard signs its new admin
    // in with the very `SessionService` every later request uses.
    const auth = AuthModule.forRoot(options.auth);
    // Built once and imported twice, by `AppModule` and by `TicketsModule`,
    // for exactly the reason `auth` is: the same object is one module to Nest,
    // so M1-06's controllers are registered once and `TicketsService` is handed
    // the very services the settings screens write through.
    const ticketing = TicketingModule.forRoot();

    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.env),
        DbModule.forRoot(options.db),
        SettingsModule.forRoot(options.settings, options.redis),
        auth,
        BrandsModule.forRoot({ logger: options.logger }),
        InstallModule.forRoot({ auth, logger: options.logger }),
        ObservabilityModule.forRoot({ logger: options.logger, bootFacts: options.bootFacts }),
        RealtimeModule.forRoot({ ...options.realtime, logger: options.logger }),
        StaffModule.forRoot({ logger: options.logger }),
        // M1-04 left two null providers behind for the contact screens; M1-02
        // fills them in. They live in `tickets/` so that contacts never learn
        // the ticket schema (`contacts/providers.ts` says why).
        ContactsModule.forRoot({
          ticketStats: new DbTicketStatsProvider(),
          timeline: new DbContactTimelineProvider(),
          // M1-14: an erasure also removes the files the person sent.
          erasure: new DbContactErasureProvider(),
        }),
        ticketing,
        TicketsModule.forRoot({ ticketing }),
        // M1-07's tab and picker. The rotation itself runs in the worker.
        AssignmentModule.forRoot({ ticketing }),
        // M1-13: a ticket's CCs. Its service is exported for M1-09's merge.
        ParticipantsModule.forRoot(),
        // M1-10. `forRoot` builds the S3 client from the bootstrap keys unless
        // a caller hands it a bucket double, which is what the suites do.
        MediaModule.forRoot({
          env: options.env,
          ...(options.objectStorage === undefined ? {} : { storage: options.objectStorage }),
        }),
        // M1-14: the Data retention form. The purge itself runs in the worker.
        RetentionModule.forRoot(),
        // Last, so its catch-all route is registered after every declared one.
        StaticModule.forRoot({ env: options.env, logger: options.logger }),
      ],
      controllers: [
        HealthController,
        MeController,
        DomainCheckController,
        ...(options.extraControllers ?? []),
      ],
      providers: [
        { provide: LOGGER, useValue: options.logger },
        { provide: PRINCIPAL_RESOLVER, useValue: options.principalResolver },
        { provide: BRAND_RESOLVER, useValue: options.brandResolver ?? new NoopBrandResolver() },
        DomainCheckService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
        { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}
