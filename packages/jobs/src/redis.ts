import { Redis } from 'ioredis';

/**
 * The connection BullMQ queues and workers share. A worker blocks on Redis
 * indefinitely, which ioredis will not do while it still counts retries per
 * request, so `maxRetriesPerRequest` has to be null; BullMQ refuses a worker
 * connection without it.
 */
export const createQueueConnection = (url: string): Redis =>
  new Redis(url, { maxRetriesPerRequest: null });
