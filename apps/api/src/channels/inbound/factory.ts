import type { Db } from '@helpdock/db';
import { AssignmentRepository } from '../../assignment/assignment.repository.js';
import { MediaRepository } from '../../media/media.repository.js';
import type { ObjectStorage } from '../../media/storage.js';
import { ParticipantsRepository } from '../../participants/participants.repository.js';
import { TicketParticipantsService } from '../../participants/ticket-participants.service.js';
import { SlaRepository } from '../../sla/sla.repository.js';
import { SlaService } from '../../sla/sla.service.js';
import { SlaLifecycleHooks } from '../../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../../tickets/tickets.repository.js';
import { StorageAttachmentSink } from './attachment-sink.js';
import { ConversationRouter } from './conversation-router.js';
import { InboundEmailService, type InboundLog } from './inbound-email.service.js';

/**
 * The inbound pipeline, built from plain constructors, because two processes
 * need it and only one of them runs Nest: the api for inbound-parse requests,
 * the worker for `email.poll`. Every piece is stateless and takes the
 * transaction it is handed, as `tickets.module.ts` notes of the same classes.
 *
 * The lifecycle hooks are M3-02's `SlaLifecycleHooks` (which extend M1-12's
 * survey hooks), the ones the api registers, so a mailed ticket starts its SLA
 * clocks and a customer reply that resumes or reopens a ticket fires exactly
 * what it would in a request.
 */
export const createInboundEmailService = (options: {
  readonly db: Db;
  readonly storage: ObjectStorage;
  readonly log: InboundLog;
}): InboundEmailService => {
  const lifecycleReads = new TicketLifecycleRepository();
  const tickets = new TicketRepository();
  const media = new MediaRepository();
  const router = new ConversationRouter({
    tickets,
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new SlaLifecycleHooks(lifecycleReads, new SlaService(new SlaRepository())),
    ),
    lifecycleReads,
    participants: new TicketParticipantsService(new ParticipantsRepository()),
    assignment: new AssignmentRepository(),
  });

  return new InboundEmailService({
    db: options.db,
    router,
    sink: () => new StorageAttachmentSink(options.storage, media),
    removeObject: (key) => options.storage.remove(key),
    log: options.log,
  });
};
