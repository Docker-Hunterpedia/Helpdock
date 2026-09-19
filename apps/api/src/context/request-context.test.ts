import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import {
  currentRequestContext,
  getTx,
  NoRequestContextError,
  RequestContext,
  requireRequestContext,
  runInRequestContext,
} from './request-context.js';

const contextFor = (requestId = 'req-1'): RequestContext =>
  new RequestContext({ requestId, method: 'GET', path: '/api/me' });

describe('the request context store', () => {
  it('is empty outside a request', () => {
    expect(currentRequestContext()).toBeUndefined();
    expect(() => requireRequestContext()).toThrow(NoRequestContextError);
    expect(() => getTx()).toThrow(NoRequestContextError);
  });

  it('is readable from anywhere inside the request, without being passed', () => {
    const context = contextFor();

    const seen = runInRequestContext(context, () => currentRequestContext());

    expect(seen).toBe(context);
  });

  it('survives awaits, which is the whole reason it exists', async () => {
    const context = contextFor('req-async');

    const seen = await runInRequestContext(context, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentRequestContext()?.requestId;
    });

    expect(seen).toBe('req-async');
  });

  it('keeps two concurrent requests apart', async () => {
    const run = (id: string): Promise<string | undefined> =>
      runInRequestContext(contextFor(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 5 : 0));
        return currentRequestContext()?.requestId;
      });

    await expect(Promise.all([run('slow'), run('fast')])).resolves.toEqual(['slow', 'fast']);
  });

  it('refuses to hand out a transaction before the interceptor opened one', () => {
    runInRequestContext(contextFor(), () => {
      expect(() => getTx()).toThrow(/tenant transaction/i);
    });
  });

  it('hands out the transaction the interceptor put there', () => {
    const context = contextFor();
    const tx = { marker: true } as unknown as DbTransaction;

    runInRequestContext(context, () => {
      context.tx = tx;
      expect(getTx()).toBe(tx);
    });
  });

  it('measures how long the request has been running', async () => {
    const context = contextFor();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(context.durationMs).toBeGreaterThan(0);
  });
});
