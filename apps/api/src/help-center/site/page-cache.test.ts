import { describe, expect, it } from 'vitest';
import { RedisStub } from '../../testing/redis-stub.js';
import {
  type CachedPage,
  etagOf,
  generationKey,
  NoPageCache,
  type PageCacheKey,
  pageKey,
  RedisPageCache,
} from './page-cache.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const key: PageCacheKey = {
  brandId: BRAND,
  host: 'help.acme.test',
  path: '/en/articles/refunds',
  locale: 'en',
  audience: 'public',
};
const page: CachedPage = {
  status: 200,
  html: '<p>hi</p>',
  etag: etagOf('<p>hi</p>'),
  noindex: false,
  widget: false,
  view: null,
};

describe('pageKey', () => {
  it('names the brand, the generation, the audience and the locale, and hashes where', () => {
    const name = pageKey(key, '3');

    expect(name).toMatch(new RegExp(`^hc:page:${BRAND}:3:public:en:[0-9a-f]{32}$`));
    expect(pageKey({ ...key, host: 'other.test' }, '3')).not.toBe(name);
    expect(pageKey({ ...key, path: '/ar/articles/refunds' }, '3')).not.toBe(name);
    expect(pageKey({ ...key, audience: 'internal' }, '3')).not.toBe(name);
    expect(pageKey({ ...key, locale: null }, '3')).toContain(':public:-:');
  });
});

describe('etagOf', () => {
  it('is a quoted, stable digest of the html', () => {
    expect(etagOf('<p>hi</p>')).toBe(etagOf('<p>hi</p>'));
    expect(etagOf('<p>hi</p>')).not.toBe(etagOf('<p>ho</p>'));
    expect(etagOf('x')).toMatch(/^"[\w-]{27}"$/);
  });
});

describe('RedisPageCache', () => {
  it('answers what it stored, until the brand is invalidated', async () => {
    const cache = new RedisPageCache(new RedisStub().asRedis());
    const miss = await cache.lookup(key);
    await cache.store(key, miss.generation, page);

    expect(miss.hit).toBeNull();
    expect((await cache.lookup(key)).hit).toEqual(page);

    await cache.invalidate(BRAND);
    expect((await cache.lookup(key)).hit).toBeNull();
  });

  it('never stores a page rendered for staff', async () => {
    const cache = new RedisPageCache(new RedisStub().asRedis());
    const internal = { ...key, audience: 'internal' as const };
    await cache.store(internal, '0', page);

    expect((await cache.lookup(internal)).hit).toBeNull();
  });

  it('files a page rendered before an invalidation where nobody reads it', async () => {
    const redis = new RedisStub();
    const cache = new RedisPageCache(redis.asRedis());
    const before = await cache.lookup(key);
    await cache.invalidate(BRAND);
    await cache.store(key, before.generation, page);

    expect((await cache.lookup(key)).hit).toBeNull();
    expect(await redis.get(generationKey(BRAND))).toBe('1');
  });

  it('treats an entry it cannot read as a miss', async () => {
    const redis = new RedisStub();
    const cache = new RedisPageCache(redis.asRedis());
    await redis.set(pageKey(key, '0'), 'not json');

    expect((await cache.lookup(key)).hit).toBeNull();
  });
});

describe('NoPageCache', () => {
  it('never hits', async () => {
    const cache = new NoPageCache();
    await cache.store(key, '0', page);
    await cache.invalidate(BRAND);

    expect(await cache.lookup(key)).toEqual({ hit: null, generation: '0' });
  });
});
