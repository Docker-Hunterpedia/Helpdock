import { describe, expect, it } from 'vitest';
import { editDistance, notFoundHelp, queryFromPath, routeScore, suggestRoutes } from './suggest.ts';

const routes = [
  '/',
  '/ar/',
  '/docs/',
  '/docs/telegram/',
  '/docs/install/',
  '/docs/importing/',
  '/channels/telegram/',
  '/ar/channels/telegram/',
  '/compare/helpdock-vs-zendesk/',
  '/changelog/1.2.0/',
];

describe('queryFromPath', () => {
  it.each([
    ['/docs/telgram-bot', 'telgram bot'],
    ['/ar/channels/whats_app/', 'whats app'],
    ['/compare/helpdock-vs-zendesk.html', 'helpdock vs zendesk'],
    ['/docs/', ''],
    ['/caf%C3%A9', 'café'],
    ['/broken%E0', 'broken%e0'],
  ])('reads %s as "%s"', (path, query) => {
    expect(queryFromPath(path)).toBe(query);
  });
});

describe('editDistance', () => {
  it.each([
    ['telegram', 'telgram', 1],
    ['install', 'instal', 1],
    ['', 'abc', 3],
    ['same', 'same', 0],
  ])('counts %s → %s as %i edits', (a, b, distance) => {
    expect(editDistance(a, b)).toBe(distance);
  });
});

describe('suggestRoutes', () => {
  it('finds a guide from a misspelled address', () => {
    expect(suggestRoutes('/docs/telgram', routes)[0]).toBe('/docs/telegram/');
    expect(suggestRoutes('/docs/instal', routes)).toEqual(['/docs/install/']);
  });

  it('finds a page from its last segment alone', () => {
    expect(suggestRoutes('/telegram', routes)).toContain('/channels/telegram/');
  });

  it('prefers the reader’s language', () => {
    expect(suggestRoutes('/ar/channels/telgram', routes)[0]).toBe('/ar/channels/telegram/');
  });

  it('offers nothing when no route is close', () => {
    expect(suggestRoutes('/zzqqxx-nothing-like-it', routes)).toEqual([]);
  });

  it('never offers more than asked', () => {
    expect(suggestRoutes('/telegram', routes, 1)).toHaveLength(1);
  });
});

describe('routeScore', () => {
  it('scores an exact match 1 and a different language lower', () => {
    expect(routeScore('/docs/telegram/', '/docs/telegram/')).toBe(1);
    expect(routeScore('/ar/channels/telegram/', '/channels/telegram/')).toBeLessThan(1);
  });
});

describe('notFoundHelp', () => {
  const known = [
    { path: '/docs/telegram/', title: 'Telegram' },
    { path: '/docs/install/', title: 'Install' },
    { path: '/channels/telegram/', title: 'Telegram' },
  ];

  it('searches for the best suggestion’s title, not the misspelt words', () => {
    const help = notFoundHelp('/docs/telgram-bot', known);
    expect(help.suggestions[0]).toEqual({ path: '/docs/telegram/', title: 'Telegram' });
    expect(help.query).toBe('Telegram');
  });

  it('falls back to the address’s words when nothing is close', () => {
    expect(notFoundHelp('/does-not-exist', known)).toEqual({
      suggestions: [],
      query: 'does not exist',
    });
  });

  it('never suggests the missing address itself', () => {
    const help = notFoundHelp('/docs/install/', known);
    expect(help.suggestions.map((route) => route.path)).not.toContain('/docs/install/');
  });
});
