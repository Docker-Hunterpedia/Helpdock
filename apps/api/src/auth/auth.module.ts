import type { EmailSender } from '@helpdock/channels';
import { LoggingEmailSender } from '@helpdock/channels';
import type { Env, Keyring, Settings } from '@helpdock/config';
import { createKeyring, decodeMasterKey } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from '../logging/logger.js';
import { DB, ENV, REDIS, SETTINGS } from '../runtime/tokens.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { EmailTokenStore } from './email-token.store.js';
import { ExchangeStore } from './exchange.store.js';
import { OauthService } from './oauth/oauth.service.js';
import { PasswordHasher } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { RefreshStore } from './session/refresh-store.js';
import { SessionService } from './session/session.service.js';
import type { SigningKeys } from './session/signing-keys.js';
import { StaffRepository } from './staff.repository.js';
import { TotpChallengeStore } from './totp/challenge-store.js';
import { TrustedDeviceStore } from './totp/trusted-device.js';

/**
 * M0-05. Everything under `/api/auth`, plus the pieces `bootstrap.ts` needs to
 * build the principal resolver before Nest exists.
 *
 * The services are wired by hand rather than with constructor injection because
 * their dependencies — the signing keys, the master key, the Redis client —
 * arrive from boot as values, and a factory per service would be the same
 * wiring written twice.
 */

export interface AuthModuleOptions {
  /** Loaded, or generated, by boot: see `session/signing-keys.ts`. */
  readonly signingKeys: SigningKeys;
  /**
   * The process logger. It arrives as a value rather than through the injector
   * because `LOGGER` is a provider of `AppModule` itself, which an imported
   * module cannot see, and because boot has it in hand already.
   */
  readonly logger: Logger;
  /** Overridden by the tests so they can read the link that was "sent". */
  readonly emailSender?: EmailSender;
}

export interface AuthRuntime {
  readonly sessions: SessionService;
  readonly auth: AuthService;
}

/** Builds the auth object graph, once per process. */
export const createAuthRuntime = ({
  env,
  db,
  redis,
  settings,
  logger,
  signingKeys,
  emailSender,
  keyring = createKeyring(env),
}: {
  readonly env: Env;
  readonly db: Db;
  readonly redis: Redis;
  readonly settings: Settings;
  readonly logger: Logger;
  readonly signingKeys: SigningKeys;
  readonly emailSender?: EmailSender;
  readonly keyring?: Keyring;
}): AuthRuntime => {
  const masterKey = decodeMasterKey(env.APP_MASTER_KEY);
  /* c8 ignore next 3 -- `loadEnv` has already refused anything that is not a 32-byte key. */
  if (masterKey === undefined) {
    throw new TypeError('APP_MASTER_KEY is not 32 bytes of base64');
  }

  const staff = new StaffRepository({ db });
  const refresh = new RefreshStore(redis);
  const hasher = new PasswordHasher(masterKey);

  const sessions = new SessionService({
    staff,
    refresh,
    redis,
    keys: signingKeys,
    logger,
    appUrl: env.APP_URL,
  });

  const auth = new AuthService({
    staff,
    sessions,
    hasher,
    challenges: new TotpChallengeStore(redis),
    trustedDevices: new TrustedDeviceStore({ redis, masterKey }),
    tokens: new EmailTokenStore(redis),
    exchanges: new ExchangeStore(redis),
    limiter: new RateLimiter(redis),
    oauth: new OauthService({ settings, redis, logger, appUrl: env.APP_URL }),
    settings,
    keyring,
    email:
      emailSender ??
      new LoggingEmailSender({
        log: (fields, message) => {
          logger.info(fields, message);
        },
      }),
    logger,
    appUrl: env.APP_URL,
  });

  return { sessions, auth };
};

/** The whole graph, built once per process and shared by both providers below. */
export const AUTH_RUNTIME = Symbol('helpdock.auth-runtime');

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        {
          provide: AUTH_RUNTIME,
          inject: [ENV, DB, REDIS, SETTINGS],
          useFactory: (env: Env, db: Db, redis: Redis, settings: Settings): AuthRuntime =>
            createAuthRuntime({
              env,
              db,
              redis,
              settings,
              logger: options.logger,
              signingKeys: options.signingKeys,
              ...(options.emailSender === undefined ? {} : { emailSender: options.emailSender }),
            }),
        },
        {
          provide: AuthService,
          inject: [AUTH_RUNTIME],
          useFactory: (runtime: AuthRuntime): AuthService => runtime.auth,
        },
        {
          provide: SessionService,
          inject: [AUTH_RUNTIME],
          useFactory: (runtime: AuthRuntime): SessionService => runtime.sessions,
        },
      ],
      exports: [AuthService, SessionService],
    };
  }
}
