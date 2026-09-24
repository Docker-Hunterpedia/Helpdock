import { describe, expect, it } from 'vitest';
import { testMessage } from './fixtures.js';
import {
  acknowledgedBy,
  MESSAGE_RETRY_AFTER_MS,
  type PendingMessage,
  pendingReducer,
} from './pending.js';

const CLIENT_ID = '0192c3f0-1a2b-7c3d-8e4f-0000000000f1';

const queued = (overrides: Partial<PendingMessage> = {}): PendingMessage => ({
  clientId: CLIENT_ID,
  kind: 'public',
  bodyHtml: '<p>On its way.</p>',
  bodyText: 'On its way.',
  attachmentIds: [],
  createdAt: '2026-09-19T12:00:00.000Z',
  sentAt: 1_000,
  state: 'sending',
  ...overrides,
});

describe('pendingReducer', () => {
  it('draws a send at once, as sending', () => {
    const state = pendingReducer([], { type: 'queued', message: queued() });

    expect(state).toEqual([queued()]);
  });

  it('replaces a queue of the same clientId rather than drawing two bubbles', () => {
    const first = pendingReducer([], { type: 'queued', message: queued() });
    const again = pendingReducer(first, {
      type: 'queued',
      message: queued({ bodyText: 'Edited' }),
    });

    expect(again).toHaveLength(1);
    expect(again[0]?.bodyText).toBe('Edited');
  });

  it('drops a message the server has acknowledged', () => {
    const state = pendingReducer([queued()], { type: 'acknowledged', clientId: CLIENT_ID });

    expect(state).toEqual([]);
  });

  it('marks a failed request as not sent', () => {
    const state = pendingReducer([queued()], { type: 'failed', clientId: CLIENT_ID });

    expect(state[0]?.state).toBe('failed');
  });

  it('calls a silent send not sent once ten seconds have passed', () => {
    const state = pendingReducer([queued({ sentAt: 0 })], {
      type: 'expired',
      now: MESSAGE_RETRY_AFTER_MS,
    });

    expect(state[0]?.state).toBe('failed');
  });

  it('leaves a send that is still inside the window alone', () => {
    const state = pendingReducer([queued({ sentAt: 0 })], {
      type: 'expired',
      now: MESSAGE_RETRY_AFTER_MS - 1,
    });

    expect(state[0]?.state).toBe('sending');
  });

  it('puts a retry back into sending, with a fresh deadline', () => {
    const failed = pendingReducer([queued({ sentAt: 0, state: 'failed' })], {
      type: 'retried',
      clientId: CLIENT_ID,
      now: 50_000,
    });

    expect(failed[0]).toMatchObject({ state: 'sending', sentAt: 50_000 });
    // And the fresh deadline is what stops it being called not sent again at once.
    expect(
      pendingReducer(failed, { type: 'expired', now: 50_000 + MESSAGE_RETRY_AFTER_MS - 1 })[0]
        ?.state,
    ).toBe('sending');
  });

  it('forgets a send that was discarded by hand', () => {
    expect(pendingReducer([queued()], { type: 'discarded', clientId: CLIENT_ID })).toEqual([]);
  });

  it('leaves other people’s sends alone', () => {
    const other = queued({ clientId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f2' });
    const state = pendingReducer([queued(), other], { type: 'failed', clientId: CLIENT_ID });

    expect(state[1]).toEqual(other);
  });
});

describe('acknowledgedBy', () => {
  it('names the sends the thread now holds, matched on clientId', () => {
    const delivered = testMessage({ seq: 4, clientId: CLIENT_ID });

    expect(acknowledgedBy([queued()], [delivered])).toEqual([CLIENT_ID]);
  });

  it('ignores messages that carry no clientId, which is every inbound one', () => {
    expect(acknowledgedBy([queued()], [testMessage({ seq: 1 })])).toEqual([]);
  });
});
