import type { StaffRefusal } from '@helpdock/schemas';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { errorBody, mapError } from '../http/error-response.js';
import { StaffFailure } from './staff-failure.js';

const REASONS: readonly StaffRefusal[] = [
  'self',
  'out-of-scope',
  'viewer-disabled',
  'last-install-admin',
  'invalid-phone',
  'photo-missing',
  'photo-too-large',
  'photo-unsupported-type',
  'photo-unreadable',
];

describe('StaffFailure', () => {
  it('answers 403 for a scope failure, because that is a permission answer', () => {
    expect(new StaffFailure('out-of-scope').getStatus()).toBe(HttpStatus.FORBIDDEN);
  });

  it('answers 409 for the three rules that are about state rather than permission', () => {
    for (const reason of ['self', 'viewer-disabled', 'last-install-admin'] as const) {
      expect(new StaffFailure(reason).getStatus(), reason).toBe(HttpStatus.CONFLICT);
    }
  });
});

describe('the profile refusals', () => {
  it.each([
    'invalid-phone',
    'photo-missing',
    'photo-too-large',
    'photo-unsupported-type',
    'photo-unreadable',
  ] as const)('answers 400 for %s, the caller sent something the profile cannot keep', (reason) => {
    expect(new StaffFailure(reason).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(mapError(new StaffFailure(reason)).code).toBe('validation_failed');
  });
});

describe('the refusal on the wire', () => {
  it.each(REASONS)('carries %s so the screen can pick its own sentence', (reason) => {
    const mapped = mapError(new StaffFailure(reason));

    expect(mapped.staff).toBe(reason);
    expect(errorBody(mapped, 'request-id').error.staff).toEqual({ reason });
  });

  it('keeps the coarse code beside the reason', () => {
    expect(mapError(new StaffFailure('out-of-scope')).code).toBe('forbidden');
    expect(mapError(new StaffFailure('self')).code).toBe('conflict');
  });

  it('leaves the field off every other failure', () => {
    expect(errorBody(mapError(new Error('boom')), 'request-id').error.staff).toBeUndefined();
  });
});
