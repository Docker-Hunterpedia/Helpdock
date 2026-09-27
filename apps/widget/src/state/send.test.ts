import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportError } from '../transport/types.js';
import { isRetryable, SEND_WINDOW_MS, uuidv7, withRetries } from './send.js';

describe('withRetries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves as soon as an attempt succeeds', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TransportError('network'))
      .mockResolvedValue('ok');

    const result = withRetries(attempt);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives up with the last error once the 10 second window has passed', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new TransportError('network'));

    const result = withRetries(attempt);
    const settled = expect(result).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(SEND_WINDOW_MS);
    await settled;

    // 500 + 1000 + 2000 + 4000 ms of backoff fit in the window; the next 4000 does not.
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it('does not retry an error a second try would get again', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new TransportError('policy_rejected'));

    await expect(withRetries(attempt)).rejects.toMatchObject({ code: 'policy_rejected' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryable', () => {
  it('retries network trouble and unknown errors, not refusals', () => {
    expect(isRetryable(new TransportError('network'))).toBe(true);
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable(new TransportError('captcha_failed'))).toBe(false);
  });
});

describe('uuidv7', () => {
  it('is a version 7, variant 10 UUID that sorts by creation time', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);

    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(early < late).toBe(true);
    expect(early.slice(0, 13)).toBe('018bcfe5-6800');
  });
});
