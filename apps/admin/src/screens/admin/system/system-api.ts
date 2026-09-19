import {
  type SystemQueuePage,
  type SystemQueuesQuery,
  type SystemStatus,
  systemQueuePageSchema,
  systemStatusSchema,
} from '@helpdock/schemas';
import type { ZodType } from 'zod';

/**
 * `GET /api/install/system`, parsed through the schema the api serves it with.
 *
 * Parsing rather than casting is the point: the page draws a status hue per
 * subsystem, and a field that quietly arrived as `undefined` would be drawn as
 * "healthy". A response that does not match is an error the page shows.
 */

/** A 403 is a state the page draws, not a failure it retries. */
export class NotAllowedError extends Error {
  constructor() {
    super('system: not allowed');
    this.name = 'NotAllowedError';
  }
}

export class SystemApiError extends Error {
  constructor(message: string) {
    super(`system: ${message}`);
    this.name = 'SystemApiError';
  }
}

export interface SystemApi {
  status(): Promise<SystemStatus>;
  /** Every queue, paginated. What "All queues" asks for. */
  queues(query: SystemQueuesQuery): Promise<SystemQueuePage>;
}

export class HttpSystemApi implements SystemApi {
  readonly #baseUrl: string;

  constructor(baseUrl = '/api') {
    this.#baseUrl = baseUrl;
  }

  async status(): Promise<SystemStatus> {
    return this.#read('/install/system', systemStatusSchema);
  }

  async queues({ page, pageSize }: SystemQueuesQuery): Promise<SystemQueuePage> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });

    return this.#read(`/install/system/queues?${query.toString()}`, systemQueuePageSchema);
  }

  async #read<T>(path: string, schema: ZodType<T>): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });

    if (response.status === 403) {
      throw new NotAllowedError();
    }
    if (!response.ok) {
      throw new SystemApiError(`the api answered ${response.status}`);
    }

    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new SystemApiError('the api answered a shape this build does not understand');
    }

    return parsed.data;
  }
}

/** How often the page asks again (DESIGN artboard `Admin/System`). */
export const SYSTEM_REFETCH_MS = 10_000;

export const SYSTEM_QUERY_KEY = ['install', 'system'] as const;
export const SYSTEM_QUEUES_QUERY_KEY = ['install', 'system', 'queues'] as const;

/**
 * One page big enough for every queue ARCHITECTURE §13 declares, so "All
 * queues" is one request. The endpoint stays paginated because the page size is
 * capped server-side and a later milestone may add queues.
 */
export const ALL_QUEUES_PAGE_SIZE = 50;
