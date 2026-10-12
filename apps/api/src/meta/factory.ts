import type { GraphClient } from '@helpdock/channels';
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
import { InstagramInboundService } from './instagram-inbound.service.js';
import { MessengerInboundService } from './messenger-inbound.service.js';
import { MetaRepository } from './meta.repository.js';
import { accountFailureRecorder } from './meta-account-failure.js';
import { createMetaMediaFetchProcessor } from './meta-media.job.js';
import { createMetaProfileProcessor } from './meta-profile.job.js';
import { MetaConversationRouter } from './meta-router.js';
import { WhatsAppInboundService } from './whatsapp-inbound.service.js';

/**
 * The Meta inbound pipeline from plain constructors, for the reason
 * `telegram/factory.ts` gives: the api runs the inbound services for the
 * webhook and the worker runs the jobs that follow them, and only one of them
 * runs Nest. The two halves share nothing but the router's repositories, so
 * each is built on its own: the api never builds a job processor it does not
 * run, and the worker never builds an inbound service it has no webhook for.
 */

export interface MetaInboundHandlersOptions {
  readonly log: JobLogger;
  /**
   * The install's `meta.appId`, which Messenger and Instagram put on the echo of
   * every message the app sent, so their inbound services can tell Helpdock's own
   * sends from the rest. The module hands the accessor in through the settings.
   */
  readonly appId: () => Promise<string>;
}

/**
 * The three platforms' inbound services (WhatsApp M10-03, Messenger M10-04,
 * Instagram M10-05), built on one router and one sink. The lifecycle hooks are
 * M3-02's, so a WhatsApp, Messenger or Instagram ticket starts its SLA clocks
 * and a customer's message resumes or reopens one exactly as in a request.
 */
export const createMetaInboundHandlers = ({ log, appId }: MetaInboundHandlersOptions) => {
  const lifecycleReads = new TicketLifecycleRepository();
  const tickets = new TicketRepository();
  const repository = new MetaRepository();
  const router = new MetaConversationRouter({
    meta: repository,
    tickets,
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new SlaLifecycleHooks(lifecycleReads, new SlaService(new SlaRepository())),
    ),
    lifecycleReads,
    assignment: new AssignmentRepository(),
    log,
  });
  const sink = new DeferredAttachmentSink(new MediaRepository());
  const parts = { router, sink, repository, lifecycleReads, log };

  return {
    whatsapp: new WhatsAppInboundService(parts),
    messenger: new MessengerInboundService({ ...parts, appId }),
    instagram: new InstagramInboundService({ ...parts, appId }),
  };
};

export interface MetaInboundJobsOptions {
  readonly db: Db;
  /** Where the media job puts the files it fetches: the bucket `media.process` reads. */
  readonly storage: ObjectStorage;
  readonly log: JobLogger;
  readonly keyring: Keyring;
  readonly graph: GraphClient;
}

export interface MetaInboundJobs {
  /** The `meta.media_fetch` consumer (M10-03), for the worker's `inbound` queue. */
  readonly mediaFetch: (job: Job) => Promise<void>;
  /** The `meta.profile_fetch` consumer (M10-05, shared with M10-04), for the same queue. */
  readonly profileFetch: (job: Job) => Promise<void>;
}

/** The jobs the inbound services raise outbox rows for: the files a message named, a customer's name. */
export const createMetaInboundJobs = (options: MetaInboundJobsOptions): MetaInboundJobs => {
  const repository = new MetaRepository();
  const recordAccountFailure = accountFailureRecorder(options.db, repository);

  return {
    profileFetch: createMetaProfileProcessor({
      db: options.db,
      log: options.log,
      repository,
      keyring: options.keyring,
      graph: options.graph,
      recordAccountFailure,
    }),
    mediaFetch: createMetaMediaFetchProcessor({
      db: options.db,
      log: options.log,
      storage: options.storage,
      graph: options.graph,
      keyring: options.keyring,
      repository,
      media: new MediaRepository(),
      recordAccountFailure,
    }),
  };
};
