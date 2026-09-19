import { authErrorCodeSchema } from '@helpdock/schemas';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { errorBody, mapError } from '../http/error-response.js';
import { AuthFailure, isAuthFailure } from './auth-failure.js';

describe('AuthFailure', () => {
  it('has a status for every code the screens can receive', () => {
    for (const code of authErrorCodeSchema.options) {
      expect(new AuthFailure(code).getStatus()).toBeGreaterThanOrEqual(400);
    }
  });

  it('answers a wrong password with 401 and the code the screen reads', () => {
    const failure = new AuthFailure('invalid-credentials');

    expect(failure.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(failure.auth).toEqual({ code: 'invalid-credentials' });
  });

  it('answers a lock and a rate limit the same way, so neither confirms an address', () => {
    expect(new AuthFailure('totp-locked').getStatus()).toBe(
      new AuthFailure('unavailable').getStatus(),
    );
  });

  it('carries the remaining attempts when there are any', () => {
    expect(new AuthFailure('totp-mismatch', { attemptsLeft: 2 }).auth).toEqual({
      code: 'totp-mismatch',
      attemptsLeft: 2,
    });
  });

  it('leaves the count off when there is none, rather than sending zero', () => {
    expect(new AuthFailure('totp-mismatch').auth).not.toHaveProperty('attemptsLeft');
  });

  it('is recognisable', () => {
    expect(isAuthFailure(new AuthFailure('unavailable'))).toBe(true);
    expect(isAuthFailure(new Error('no'))).toBe(false);
  });
});

describe('the body an auth failure produces', () => {
  it('keeps the one envelope every failure uses and adds the detail beside it', () => {
    const mapped = mapError(new AuthFailure('totp-mismatch', { attemptsLeft: 1 }));

    expect(errorBody(mapped, 'req-1')).toEqual({
      error: {
        code: 'unauthenticated',
        message: 'That authentication code does not match',
        requestId: 'req-1',
        auth: { code: 'totp-mismatch', attemptsLeft: 1 },
      },
    });
  });

  it('adds nothing to an ordinary failure', () => {
    expect(errorBody(mapError(new Error('boom')), 'req-1').error).not.toHaveProperty('auth');
  });

  it('maps a lock to the rate-limited code, which is what it is', () => {
    expect(mapError(new AuthFailure('totp-locked'))).toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'rate_limited',
    });
  });

  it('never marks an auth failure as unexpected: the log must not fill with wrong passwords', () => {
    expect(mapError(new AuthFailure('invalid-credentials')).unexpected).toBe(false);
  });
});
