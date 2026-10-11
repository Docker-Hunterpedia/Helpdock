import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { MediaRepository } from '../media/media.repository.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { SlaLifecycleHooks } from '../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import { DeferredAttachmentSink } from './deferred-sink.js';
import { InstagramInboundService } from './instagram-inbound.service.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaInboundLog } from './meta-inbound.service.js';
import { MetaConversationRouter } from './meta-router.js';

/**
 * The Instagram inbound service from plain constructors, as
 * `createTelegramInboundService` builds Telegram's: the lifecycle hooks are
 * M3-02's, so an Instagram ticket starts its SLA clocks and a customer's
 * message resumes or reopens one exactly as in a request.
 */
export const createInstagramInboundService = (options: {
  readonly repository: MetaRepository;
  readonly appId: () => Promise<string>;
  readonly log: MetaInboundLog;
}): InstagramInboundService => {
  const lifecycleReads = new TicketLifecycleRepository();
  const tickets = new TicketRepository();
  const router = new MetaConversationRouter({
    meta: options.repository,
    tickets,
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new SlaLifecycleHooks(lifecycleReads, new SlaService(new SlaRepository())),
    ),
    lifecycleReads,
    assignment: new AssignmentRepository(),
  });

  return new InstagramInboundService({
    repository: options.repository,
    router,
    sink: new DeferredAttachmentSink(new MediaRepository()),
    tickets,
    lifecycleReads,
    appId: options.appId,
    log: options.log,
  });
};
