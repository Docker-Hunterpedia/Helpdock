import {
  type ImportHealth,
  type ImportHealthPage,
  type ImportHealthQuery,
  importBrandHealthSchema,
  importHealthPageSchema,
  importHealthQuerySchema,
  importHealthSchema,
} from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

export const IMPORT_HEALTH_KEY = 'hd:imports:health';
export const IMPORT_HEALTH_TTL_SECONDS = 180;
const PAGE_SIZE = 50;
type BrandHealth = z.infer<typeof importBrandHealthSchema>;
type Snapshot = Extract<ImportHealth, { configured: true }> & { snapshotId: string };
const dataKey = (id: string) => `${IMPORT_HEALTH_KEY}:${id}:data`;
const orderKey = (id: string) => `${IMPORT_HEALTH_KEY}:${id}:order`;

function parseHealth(raw: string | null): ImportHealth {
  if (!raw) return { configured: false };
  try {
    const parsed = importHealthSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { configured: false };
  } catch (error) {
    if (error instanceof SyntaxError) return { configured: false };
    throw error;
  }
}

/** A missing/expired/malformed reading is unknown, never a measured zero. */
export async function readImportHealth(redis: Pick<Redis, 'get'>): Promise<ImportHealth> {
  const raw = await redis.get(IMPORT_HEALTH_KEY);
  return parseHealth(raw);
}

export async function writeImportHealth(redis: Pick<Redis, 'set'>, value: ImportHealth) {
  const reading = importHealthSchema.parse(value);
  await redis.set(IMPORT_HEALTH_KEY, JSON.stringify(reading), 'EX', IMPORT_HEALTH_TTL_SECONDS);
}

/** Fixed-width ASCII keys give Redis and the bounded summary exactly the same ordering. */
export function importHealthOrder(row: BrandHealth): string {
  const inverse = (value: number) => String(Number.MAX_SAFE_INTEGER - value).padStart(16, '0');
  return `${inverse(row.active)}:${inverse(row.paused)}:${inverse(row.lastError ? Date.parse(row.lastError.at) : 0)}:${row.brandId}`;
}

function written(result: readonly (readonly [Error | null, unknown])[] | null): void {
  if (!result) throw new Error('import.health-cache-write-aborted');
  for (const [error] of result) if (error) throw error;
}

/** A version is private until publication; stalled or failed builds disappear by TTL. */
export async function writeImportHealthBrand(redis: Redis, snapshotId: string, raw: BrandHealth) {
  const row = importBrandHealthSchema.parse(raw);
  written(
    await redis
      .multi()
      .hset(dataKey(snapshotId), row.brandId, JSON.stringify(row))
      .expire(dataKey(snapshotId), IMPORT_HEALTH_TTL_SECONDS)
      .zadd(orderKey(snapshotId), 0, importHealthOrder(row))
      .expire(orderKey(snapshotId), IMPORT_HEALTH_TTL_SECONDS)
      .exec(),
  );
}

export async function publishImportHealthSnapshot(redis: Redis, raw: Snapshot) {
  const reading = importHealthSchema.options[1].parse(raw);
  if (!reading.snapshotId) throw new Error('import.health-snapshot-id-required');
  if ((await redis.zcard(orderKey(reading.snapshotId))) !== reading.totalBrands)
    throw new Error('import.health-snapshot-incomplete');
  const metadata = await redis.hexists(dataKey(reading.snapshotId), '__meta');
  if ((await redis.hlen(dataKey(reading.snapshotId))) !== reading.totalBrands + metadata)
    throw new Error('import.health-snapshot-incomplete');
  const text = JSON.stringify(reading);
  written(
    await redis
      .multi()
      .hset(dataKey(reading.snapshotId), '__meta', text)
      .expire(dataKey(reading.snapshotId), IMPORT_HEALTH_TTL_SECONDS)
      .expire(orderKey(reading.snapshotId), IMPORT_HEALTH_TTL_SECONDS)
      .set(IMPORT_HEALTH_KEY, text, 'EX', IMPORT_HEALTH_TTL_SECONDS)
      .exec(),
  );
}

/** Install scope reads only the immutable cache version; missing members invalidate the reading. */
export async function readImportHealthPage(
  redis: Redis,
  raw: ImportHealthQuery,
): Promise<ImportHealthPage> {
  const query = importHealthQuerySchema.parse(raw);
  const current = query.snapshotId
    ? parseHealth(await redis.hget(dataKey(query.snapshotId), '__meta'))
    : await readImportHealth(redis);
  if (!current.configured || (query.snapshotId && current.snapshotId !== query.snapshotId))
    return { configured: false };
  if (!current.snapshotId)
    return query.page === 1 && current.totalBrands <= current.brands.length
      ? importHealthPageSchema.parse({ ...current, page: 1, hasNext: false })
      : { configured: false };
  const start = (query.page - 1) * PAGE_SIZE;
  const ids = (
    await redis.zrange(orderKey(current.snapshotId), String(start), String(start + PAGE_SIZE - 1))
  ).map((member) => member.slice(-36));
  if (
    ids.length !== Math.max(0, Math.min(PAGE_SIZE, current.totalBrands - start)) ||
    (await redis.zcard(orderKey(current.snapshotId))) !== current.totalBrands ||
    (await redis.hlen(dataKey(current.snapshotId))) !== current.totalBrands + 1
  )
    return { configured: false };
  const values = ids.length ? await redis.hmget(dataKey(current.snapshotId), ...ids) : [];
  const brands: BrandHealth[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value) return { configured: false };
    try {
      const row = importBrandHealthSchema.safeParse(JSON.parse(value));
      if (!row.success || row.data.brandId !== ids[index]) return { configured: false };
      brands.push(row.data);
    } catch (error) {
      if (error instanceof SyntaxError) return { configured: false };
      throw error;
    }
  }
  return importHealthPageSchema.parse({
    ...current,
    brands,
    page: query.page,
    hasNext: start + brands.length < current.totalBrands,
  });
}
