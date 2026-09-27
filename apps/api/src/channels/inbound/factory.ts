import type { Db } from '@helpdock/db';
import { AssignmentRepository } from '../../assignment/assignment.repository.js';
import { CsatLifecycleHooks } from '../../csat/csat-hooks.js';
import { MediaRepository } from '../../media/media.repository.js';
import type { ObjectStorage } from '../../media/storage.js';
import { ParticipantsRepository } from '../../participants/participants.repository.js';
import { TicketParticipantsService } from '../../participants/ticket-participants.service.js';
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
 * The lifecycle hooks are M1-12's `CsatLifecycleHooks`, the ones the api
 * registers, so a customer reply that reopens a ticket fires exactly what it
 * would in a request.
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
      new CsatLifecycleHooks(lifecycleReads),
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
