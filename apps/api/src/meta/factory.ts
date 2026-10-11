import type { Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import type { JobLogger } from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { MediaRepository } from '../media/media.repository.js';
import type { ObjectStorage } from '../media/storage.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { SlaLifecycleHooks } from '../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import { DeferredAttachmentSink } from './deferred-sink.js';
import type { GraphClientFactory } from './graph-client-factory.js';
import { MetaRepository } from './meta.repository.js';
import { accountFailureRecorder, createMetaMediaFetchProcessor } from './meta-media.job.js';
import { MetaConversationRouter } from './meta-router.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';

/**
 * The Meta inbound pipeline from plain constructors, for the reason
 * `telegram/factory.ts` gives: the api runs the inbound services for the
 * webhook and the worker runs the media fetch, and only one of them runs Nest.
 * The lifecycle hooks are M3-02's, so a WhatsApp, Messenger or Instagram ticket
 * starts its SLA clocks and a customer's message resumes or reopens one exactly
 * as in a request.
 *
 * One router and one sink serve all three platforms; each platform's inbound
 * service is built on them and returned beside them (`whatsapp`, M10-03;
 * `messenger`, M10-04; `instagram`, M10-05).
 */

export interface MetaInboundOptions {
  readonly db: Db;
  /** Where the media job puts the files it fetches: the bucket `media.process` reads. */
  readonly storage: ObjectStorage;
  readonly log: JobLogger;
  readonly keyring: Keyring;
  readonly graph: GraphClientFactory;
}

export interface MetaInbound {
  readonly router: MetaConversationRouter;
  readonly sink: DeferredAttachmentSink;
  /** WhatsApp's events (M10-03), for `MetaModule`'s handler map. */
  readonly whatsapp: WhatsAppInboundService;
  /** The `meta.media_fetch` consumer, for the worker's `inbound` queue. */
  readonly mediaFetch: (job: Job) => Promise<void>;
}

export const createMetaInboundService = (options: MetaInboundOptions): MetaInbound => {
  const lifecycleReads = new TicketLifecycleRepository();
  const tickets = new TicketRepository();
  const meta = new MetaRepository();
  const media = new MediaRepository();
  const router = new MetaConversationRouter({
    meta,
    tickets,
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new SlaLifecycleHooks(lifecycleReads, new SlaService(new SlaRepository())),
    ),
    lifecycleReads,
    assignment: new AssignmentRepository(),
    log: options.log,
  });

  const sink = new DeferredAttachmentSink(media);

  return {
    router,
    sink,
    whatsapp: new WhatsAppInboundService({
      router,
      sink,
      repository: meta,
      lifecycleReads,
      log: options.log,
    }),
    mediaFetch: createMetaMediaFetchProcessor({
      db: options.db,
      log: options.log,
      storage: options.storage,
      graph: options.graph,
      keyring: options.keyring,
      repository: meta,
      media,
      recordAccountFailure: accountFailureRecorder(options.db, meta),
    }),
  };
};
