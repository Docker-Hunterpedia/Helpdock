/**
 * Injection tokens for the things `ObservabilityModule` builds. They live here
 * rather than in `runtime/tokens.ts` because they belong to this module and
 * nothing outside it injects them; the module is meant to be readable on its
 * own.
 */

export const METRICS = Symbol('helpdock.metrics');
/** The logger boot built, so this module need not make it global. */
export const OBSERVABILITY_LOGGER = Symbol('helpdock.observability-logger');
export const QUEUE_REGISTRY = Symbol('helpdock.queue-registry');
/** What boot learned and the request path cannot ask for again. */
export const BOOT_FACTS = Symbol('helpdock.boot-facts');
