import type { Ai } from '@helpdock/ai';
import type { Db } from '@helpdock/db';
import type { JobLogger } from '@helpdock/jobs';
import { EmailRepository } from '../../email/email.repository.js';
import { EmailReplyHook } from '../../email/email-reply.hook.js';
import { OutboundEmailService } from '../../email/outbound-email.service.js';
import type { InstallSmtp } from '../../email/transport.js';
import { createQueryEmbedder, createRetriever } from '../../knowledge/retrieval/retrieve.js';
import { SlaRepository } from '../../sla/sla.repository.js';
import { SlaService } from '../../sla/sla.service.js';
import { SlaLifecycleHooks } from '../../sla/sla-hooks.js';
import { OutboundTelegramService } from '../../telegram/outbound-telegram.service.js';
import { TelegramRepository } from '../../telegram/telegram.repository.js';
import { TelegramReplyHook } from '../../telegram/telegram-reply.hook.js';
import { TicketLifecycleRepository } from '../../tickets/lifecycle/lifecycle.repository.js';
import { ChannelReplyDeliveryHooks } from '../../tickets/reply-delivery.hook.js';
import type { AutoReplyDeps } from './auto-reply.job.js';
import { readAutoReplySettings } from './auto-reply-settings.js';

/**
 * What `ai.auto_reply` runs with in the worker, built outside Nest as the
 * rules engine's are (`rules/engine-deps.ts`): the same reply delivery
 * `TicketsModule` gives an agent's reply, and M3-02's clocks.
 */
export const createAutoReplyDeps = ({
  db,
  ai,
  installSmtp,
  log,
}: {
  readonly db: Db;
  readonly ai: Pick<Ai, 'complete' | 'embed'>;
  readonly installSmtp: InstallSmtp;
  readonly log: JobLogger;
}): AutoReplyDeps => {
  const hooks = new SlaLifecycleHooks(
    new TicketLifecycleRepository(),
    new SlaService(new SlaRepository()),
  );
  return {
    db,
    ai,
    retriever: createRetriever({
      db,
      embedQuery: createQueryEmbedder(db, ai, (error) =>
        log.warn({ err: error }, 'auto-reply query embedding failed; full text only'),
      ),
    }),
    settings: readAutoReplySettings,
    delivery: new ChannelReplyDeliveryHooks([
      new EmailReplyHook(new OutboundEmailService(new EmailRepository(), installSmtp)),
      new TelegramReplyHook(new OutboundTelegramService(new TelegramRepository())),
    ]),
    responded: (tx, event) => hooks.onResponded(tx, event),
    log,
  };
};
