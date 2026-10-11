import { GraphApiFailure } from '@helpdock/channels';
import { describe, expect, it, vi } from 'vitest';
import { needsProfile, readInstagramProfile } from './instagram-profile.js';

const TOKEN = 'IGQWRPbGl0ZXN0dG9rZW4xMjM0NTY3ODkw';

const graphReturning = (body: unknown) => ({ get: vi.fn(() => Promise.resolve(body)) });
const graphFailing = (error: unknown) => ({ get: vi.fn(() => Promise.reject(error)) });

describe('needsProfile', () => {
  it('asks for a conversation that does not exist yet', () => {
    expect(needsProfile(undefined)).toBe(true);
  });

  it('asks for one that has neither a name nor a handle', () => {
    expect(needsProfile({ profileName: null, username: null })).toBe(true);
  });

  it('is satisfied by a name or a handle alone', () => {
    expect(needsProfile({ profileName: 'Sheena', username: null })).toBe(false);
    expect(needsProfile({ profileName: null, username: 'sheena.n' })).toBe(false);
  });
});

describe('readInstagramProfile', () => {
  it('reads name and username on the Instagram root with the account’s token', async () => {
    const graph = graphReturning({ id: '1784', name: 'Sheena Nelson', username: 'sheena.n' });

    const result = await readInstagramProfile({ graph, token: TOKEN, igsid: '1784' });

    expect(result).toEqual({ ok: true, profile: { name: 'Sheena Nelson', username: 'sheena.n' } });
    expect(graph.get).toHaveBeenCalledExactlyOnceWith('/1784', {
      token: TOKEN,
      api: 'instagram',
      query: { fields: 'name,username' },
    });
  });

  it('keeps what is there when Meta sends only one of the two', async () => {
    expect(
      await readInstagramProfile({
        graph: graphReturning({ id: '1', username: 'sheena.n' }),
        token: TOKEN,
        igsid: '1',
      }),
    ).toEqual({ ok: true, profile: { name: null, username: 'sheena.n' } });
  });

  it('treats blank strings as missing and an answer with neither as no profile', async () => {
    expect(
      await readInstagramProfile({
        graph: graphReturning({ id: '1', name: '  ', username: '' }),
        token: TOKEN,
        igsid: '1',
      }),
    ).toEqual({ ok: false, reason: 'empty', code: null });
  });

  it('reports Graph’s refusal by class and code, not by its words', async () => {
    const result = await readInstagramProfile({
      graph: graphFailing(new GraphApiFailure('permission', 'denied', { code: 10 })),
      token: TOKEN,
      igsid: '1',
    });

    expect(result).toEqual({ ok: false, reason: 'permission', code: 10 });
  });

  it('reports an answer in a shape it does not know as a permanent failure', async () => {
    const result = await readInstagramProfile({
      graph: graphReturning('not an object'),
      token: TOKEN,
      igsid: '1',
    });

    expect(result).toEqual({ ok: false, reason: 'permanent', code: null });
  });

  it('reports anything else it is thrown as an error without its message', async () => {
    const result = await readInstagramProfile({
      graph: graphFailing(new TypeError(`bad token ${TOKEN}`)),
      token: TOKEN,
      igsid: '1',
    });

    expect(result).toEqual({ ok: false, reason: 'error', code: null });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('gives up after the timeout so a slow Meta cannot hold the webhook', async () => {
    vi.useFakeTimers();
    try {
      const graph = { get: vi.fn(() => new Promise<unknown>(() => undefined)) };
      const pending = readInstagramProfile({ graph, token: TOKEN, igsid: '1', timeoutMs: 3_000 });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(await pending).toEqual({ ok: false, reason: 'timeout', code: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for a fast answer to be the last word', async () => {
    vi.useFakeTimers();
    try {
      const graph = graphReturning({ id: '1', username: 'a' });
      const pending = readInstagramProfile({ graph, token: TOKEN, igsid: '1' });

      expect(await pending).toMatchObject({ ok: true });
      // The timer was cleared with the answer; nothing is left to fire.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
