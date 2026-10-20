import type { Db } from '@helpdock/db';
import type { FactoryProvider } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { lexicalSource } from '../help-center/search/lexical.js';
import { QuickSearchModule } from './quick-search.module.js';

const searchService = vi.hoisted(() => vi.fn());
vi.mock('../help-center/search/search.service.js', () => ({
  HelpCenterSearchService: searchService,
}));

describe('QuickSearchModule', () => {
  it('searches articles by full text alone: no query embedder, so no model call per keystroke (ADR 0038)', () => {
    const module = QuickSearchModule.forRoot({
      tickets: { module: class Tickets {} },
      contacts: { module: class Contacts {} },
      redis: {} as Redis,
    });
    const provider = (module.providers ?? []).find(
      (candidate): candidate is FactoryProvider => 'useFactory' in (candidate as object),
    );
    const db = {} as Db;

    provider?.useFactory({}, {}, db);

    expect(searchService).toHaveBeenCalledTimes(1);
    const [receivedDb, options] = searchService.mock.calls[0] as [Db, Record<string, unknown>];
    expect(receivedDb).toBe(db);
    expect(options).toEqual({ sources: [lexicalSource] });
    expect(options).not.toHaveProperty('embedQuery');
  });
});
