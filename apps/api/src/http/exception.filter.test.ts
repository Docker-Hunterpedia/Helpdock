import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IdentityContentionError } from '../contacts/identity.js';
import type { Logger } from '../logging/logger.js';
import { AllExceptionsFilter } from './exception.filter.js';

const run = (error: unknown) => {
  const headers: Record<string, string> = {};
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    status: (status: number) => {
      sent.status = status;
      return { send: (body: unknown) => (sent.body = body) };
    },
  };
  const logger = { child: () => logger, error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const host = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter(logger).catch(error, host);

  return { headers, sent };
};

describe('AllExceptionsFilter', () => {
  it('answers a lost identity race with 503 and Retry-After', () => {
    const { headers, sent } = run(new IdentityContentionError());

    expect(sent.status).toBe(503);
    expect(headers['Retry-After']).toBe('1');
    expect(sent.body).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('sets no Retry-After on an ordinary failure', () => {
    const { headers, sent } = run(new Error('boom'));

    expect(sent.status).toBe(500);
    expect(headers['Retry-After']).toBeUndefined();
  });
});
