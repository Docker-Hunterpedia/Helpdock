import { describe, expect, it } from 'vitest';
import { envKeyOf, nextWindow, percentOf, usd } from './format.js';
import { aiTabsFor } from './tabs.js';

describe('envKeyOf', () => {
  it('spells a settings key the way @helpdock/config’s toEnvKey does', () => {
    expect(envKeyOf('transcription.endpoint')).toBe('HD_TRANSCRIPTION_ENDPOINT');
    expect(envKeyOf('embedding.pricePerMillionTokens')).toBe(
      'HD_EMBEDDING_PRICE_PER_MILLION_TOKENS',
    );
  });
});

describe('nextWindow', () => {
  const now = new Date('2026-10-28T16:40:00Z');

  it('opens the next UTC day and the first of next month', () => {
    expect(nextWindow('day', now).toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(nextWindow('month', now).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('usd and percentOf', () => {
  it('formats cents, or more digits for a single call', () => {
    expect(usd(1.2)).toBe('$1.20');
    expect(usd(0.0014, 4)).toBe('$0.0014');
    expect(percentOf(40, 50)).toBe(80);
  });
});

describe('aiTabsFor', () => {
  it('offers Providers to an install admin alone, and the brand tabs to ai:manage roles', () => {
    const keys = (role: 'admin' | 'teamLeader' | 'agent', installAdmin: boolean) =>
      aiTabsFor({ role, installAdmin }).map((tab) => tab.key);

    expect(keys('admin', true)).toEqual(['providers', 'knowledge', 'assistant']);
    expect(keys('admin', false)).toEqual(['knowledge', 'assistant']);
    expect(keys('teamLeader', false)).toEqual(['knowledge', 'assistant']);
    expect(keys('agent', false)).toEqual([]);
  });
});
