/**
 * The queues of ARCHITECTURE §13. A queue is a routing decision — what shares a
 * concurrency budget and a retry profile — so the names live in one place and
 * every job definition points at one of them.
 */
export const QUEUE_NAMES = {
  /** `email.poll`, `telegram.update`, `form.submit`. Deduped by external id. */
  inbound: 'inbound',
  /** `email.send`, `telegram.send`, `widget.deliver`. */
  outbound: 'outbound',
  /** `sla.first_response`, `sla.resolution`, `sla.escalate`. Delayed jobs. */
  sla: 'sla',
  /** `rules.evaluate`, `rules.time_based`. */
  rules: 'rules',
  /** `ai.assist`, `ai.autoreply`, `ai.classify`, `ai.transcribe`. */
  ai: 'ai',
  /** `ingest.source`, `ingest.chunk_embed`, `crawl.page`. */
  knowledge: 'knowledge',
  /** `media.process`, `media.scan`. */
  media: 'media',
  /** `notify.inapp`, `notify.email`, `notify.push`. */
  notify: 'notify',
  /** `webhook.deliver`. */
  webhooks: 'webhooks',
  /** `outbox.relay` and the `outbox.event` fan-out it publishes (DOMAIN-RULES §6). */
  outbox: 'outbox',
  /** `assignment.offline_unassign` (M1-07). Delayed jobs. */
  assignment: 'assignment',
  /** `cleanup.tokens`, `maintenance.retention`, `stats.rollup`, `sla.rebuild`. */
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every queue name, for iterating: Bull Board, the queue-depth metrics of ARCHITECTURE §14. */
export const QUEUE_NAME_LIST: readonly QueueName[] = Object.values(QUEUE_NAMES);
