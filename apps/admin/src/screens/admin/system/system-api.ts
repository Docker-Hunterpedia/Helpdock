import {
  type AuditLogPage,
  type AuditLogQuery,
  auditLogPageSchema,
  type Brand,
  type BrandDeletion,
  brandDeletionSchema,
  brandListSchema,
  type ProductMetrics,
  productMetricsSchema,
  queueBoardPassSchema,
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
  /** The HTTP status, when the api answered at all: 400 and 409 have their own sentences. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(`system: ${message}`);
    this.name = 'SystemApiError';
    this.status = status;
  }
}

/** The access token to send, or null without one; the app's transport supplies it. */
export type AccessTokenSource = () => Promise<string | null>;

export interface SystemApi {
  status(): Promise<SystemStatus>;
  /** Every queue, paginated. What "All queues" asks for. */
  queues(query: SystemQueuesQuery): Promise<SystemQueuePage>;
  /** M3-08: one page of the install-wide audit log, newest first. */
  auditLog(query: Partial<Omit<AuditLogQuery, 'limit'>>): Promise<AuditLogPage>;
  /** M8-07: DOMAIN-RULES §15's product metrics. */
  productMetrics(): Promise<ProductMetrics>;
  /** M8-05: a one-use address that opens Bull Board, good for a minute. */
  queueBoardPass(): Promise<string>;
  /** Every brand in the install, with its status (pending deletion is `deleting`). */
  brands(): Promise<readonly Brand[]>;
  /** M8-07: where a brand is in its deletion. */
  brandDeletion(brandId: string): Promise<BrandDeletion>;
  /** Starts the 30-day grace; the api checks the typed prefix. */
  deleteBrand(brandId: string, confirmPrefix: string): Promise<BrandDeletion>;
  /** Takes the deletion back while the grace lasts. */
  restoreBrand(brandId: string): Promise<BrandDeletion>;
}

export class HttpSystemApi implements SystemApi {
  readonly #baseUrl: string;
  readonly #token: AccessTokenSource;

  constructor(token: AccessTokenSource = async () => null, baseUrl = '/api') {
    this.#token = token;
    this.#baseUrl = baseUrl;
  }

  async status(): Promise<SystemStatus> {
    return this.#read('/install/system', systemStatusSchema);
  }

  async queues({ page, pageSize }: SystemQueuesQuery): Promise<SystemQueuePage> {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });

    return this.#read(`/install/system/queues?${query.toString()}`, systemQueuePageSchema);
  }

  async auditLog(query: Partial<Omit<AuditLogQuery, 'limit'>>): Promise<AuditLogPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const search = params.toString();

    return this.#read(`/install/audit-log${search === '' ? '' : `?${search}`}`, auditLogPageSchema);
  }

  async productMetrics(): Promise<ProductMetrics> {
    return this.#read('/install/system/metrics', productMetricsSchema);
  }

  async queueBoardPass(): Promise<string> {
    const pass = await this.#send('POST', '/install/system/queue-board', queueBoardPassSchema);

    return pass.url;
  }

  async brands(): Promise<readonly Brand[]> {
    return (await this.#read('/install/brands', brandListSchema)).brands;
  }

  async brandDeletion(brandId: string): Promise<BrandDeletion> {
    return this.#read(this.#deletion(brandId), brandDeletionSchema);
  }

  async deleteBrand(brandId: string, confirmPrefix: string): Promise<BrandDeletion> {
    return this.#send('POST', this.#deletion(brandId), brandDeletionSchema, { confirmPrefix });
  }

  async restoreBrand(brandId: string): Promise<BrandDeletion> {
    return this.#send('DELETE', this.#deletion(brandId), brandDeletionSchema);
  }

  #deletion(brandId: string): string {
    return `/install/brands/${encodeURIComponent(brandId)}/deletion`;
  }

  async #read<T>(path: string, schema: ZodType<T>): Promise<T> {
    return this.#send('GET', path, schema);
  }

  async #send<T>(method: string, path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
    const token = await this.#token();
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 403) {
      throw new NotAllowedError();
    }
    if (!response.ok) {
      throw new SystemApiError(`the api answered ${response.status}`, response.status);
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
export const AUDIT_LOG_QUERY_KEY = ['install', 'audit-log'] as const;
export const PRODUCT_METRICS_QUERY_KEY = ['install', 'system', 'metrics'] as const;
export const INSTALL_BRANDS_QUERY_KEY = ['install', 'brands'] as const;
export const brandDeletionQueryKey = (brandId: string) =>
  ['install', 'brands', brandId, 'deletion'] as const;

/**
 * One page big enough for every queue ARCHITECTURE §13 declares, so "All
 * queues" is one request. The endpoint stays paginated because the page size is
 * capped server-side and a later milestone may add queues.
 */
export const ALL_QUEUES_PAGE_SIZE = 50;
