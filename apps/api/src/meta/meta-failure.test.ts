import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MetaFailure } from './meta-failure.js';

describe('MetaFailure', () => {
  it('answers a closed reply window with a 409 that carries what the composer needs', () => {
    const details = {
      platform: 'whatsapp',
      anchorAt: '2026-10-10T08:00:00.000Z',
      closedAt: '2026-10-11T08:00:00.000Z',
    } as const;
    const failure = new MetaFailure('reply-window-closed', details);

    expect(failure.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(failure.reason).toBe('reply-window-closed');
    expect(failure.details).toEqual(details);
  });

  it.each([
    ['token-invalid', HttpStatus.BAD_REQUEST],
    ['token-other-account', HttpStatus.BAD_REQUEST],
    ['platform-mismatch', HttpStatus.BAD_REQUEST],
    ['department-not-found', HttpStatus.NOT_FOUND],
    ['graph-unreachable', HttpStatus.CONFLICT],
    ['account-taken', HttpStatus.CONFLICT],
    ['app-not-configured', HttpStatus.CONFLICT],
    ['subscribe-failed', HttpStatus.CONFLICT],
  ] as const)('maps %s to %i', (reason, status) => {
    const failure = new MetaFailure(reason);

    expect(failure.getStatus()).toBe(status);
    expect(failure.details).toBeUndefined();
    expect(failure.message.length).toBeGreaterThan(0);
  });
});
