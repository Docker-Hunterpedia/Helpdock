import type { Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { StorageAttachmentSink } from '../channels/inbound/attachment-sink.js';
import type { InboundLog } from '../channels/inbound/inbound-email.service.js';
import { CsatRepository } from '../csat/csat.repository.js';
import { CsatTelegramTaps } from '../csat/telegram-csat.js';
import { MediaRepository } from '../media/media.repository.js';
import type { ObjectStorage } from '../media/storage.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { SlaLifecycleHooks } from '../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import type { TelegramApiFactory } from './bot-api-factory.js';
import { TelegramRepository } from './telegram.repository.js';
import { TelegramInboundService } from './telegram-inbound.service.js';
import { TelegramConversationRouter } from './telegram-router.js';

/**
 * The Telegram inbound pipeline from plain constructors, for the reason
 * `channels/inbound/factory.ts` gives: the api runs it for the webhook and the
 * worker for development polling, and only one of them runs Nest. The
 * lifecycle hooks are M3-02's, so a Telegram ticket starts its SLA clocks and
 * a customer's message resumes or reopens one exactly as in a request.
 */
export const createTelegramInboundService = (options: {
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly log: InboundLog;
  readonly keyring: Keyring;
  readonly api: TelegramApiFactory;
}): TelegramInboundService => {
  const lifecycleReads = new TicketLifecycleRepository();
  const tickets = new TicketRepository();
  const telegram = new TelegramRepository();
  const media = new MediaRepository();
  const router = new TelegramConversationRouter({
    telegram,
    tickets,
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new SlaLifecycleHooks(lifecycleReads, new SlaService(new SlaRepository())),
    ),
    lifecycleReads,
    assignment: new AssignmentRepository(),
  });

  return new TelegramInboundService({
    db: options.db,
    repository: telegram,
    router,
    lifecycleReads,
    csatTaps: new CsatTelegramTaps(new CsatRepository()),
    keyring: options.keyring,
    api: options.api,
    sink: () => new StorageAttachmentSink(options.storage, media),
    removeObject: (key) => options.storage.remove(key),
    log: options.log,
  });
};
