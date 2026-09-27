import { createKeyring, type Env, type Settings } from '@helpdock/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { ENV, SETTINGS } from '../runtime/tokens.js';
import {
  EmailSettingsController,
  SignatureController,
  TicketEmailController,
} from './email.controller.js';
import { EmailRepository } from './email.repository.js';
import { EmailSettingsService } from './email-settings.service.js';
import { OutboundEmailService } from './outbound-email.service.js';
import {
  SettingsInstallSmtp,
  type SmtpTransportFactory,
  smtpTransportFactory,
} from './transport.js';

/**
 * M2-05, M2-06 and M2-08's outbound half, over http: Channels › Outgoing
 * email, the signature tab, and the ticket view's email context. Sending
 * itself is the worker's (`email-send.job.ts`); the reply path reaches the
 * outbox through `TicketsModule`'s `ReplyDeliveryHook`.
 */

export interface EmailModuleOptions {
  /** A test's SMTP double for "Test SMTP"; production builds Nodemailer. */
  readonly transports?: SmtpTransportFactory;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class EmailModule {
  static forRoot({ transports = smtpTransportFactory }: EmailModuleOptions = {}): DynamicModule {
    return {
      module: EmailModule,
      controllers: [EmailSettingsController, TicketEmailController, SignatureController],
      providers: [
        {
          provide: EmailSettingsService,
          inject: [ENV, SETTINGS],
          useFactory: (env: Env, settings: Settings): EmailSettingsService => {
            const repository = new EmailRepository();
            const installSmtp = new SettingsInstallSmtp(settings);

            return new EmailSettingsService({
              repository,
              outbound: new OutboundEmailService(repository, installSmtp),
              keyring: createKeyring(env),
              installSmtp,
              transports,
            });
          },
        },
      ],
    };
  }
}
