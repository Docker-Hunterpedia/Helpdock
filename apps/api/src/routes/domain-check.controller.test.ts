import { domainCheckQuerySchema } from '@helpdock/schemas';
import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DomainCheckController } from './domain-check.controller.js';
import type { DomainCheckService } from './domain-check.service.js';

const controllerFor = (verified: readonly string[]): DomainCheckController => {
  const service = {
    isVerifiedHelpcenterDomain: (domain: string) => Promise.resolve(verified.includes(domain)),
  } as DomainCheckService;

  return new DomainCheckController(service);
};

const requestFrom = (ip: string): FastifyRequest => ({ ip }) as FastifyRequest;

/** What the validation pipe hands the handler, so the test exercises the same value. */
const query = (domain: string) => domainCheckQuerySchema.parse({ domain });

describe('DomainCheckController', () => {
  it('answers 200 for a verified help center domain, which is what lets Caddy issue', async () => {
    const controller = controllerFor(['help.acme.test']);

    await expect(
      controller.check(query('help.acme.test'), requestFrom('10.0.0.1')),
    ).resolves.toEqual({ domain: 'help.acme.test' });
  });

  it('refuses a domain the install does not serve', async () => {
    const controller = controllerFor([]);

    await expect(
      controller.check(query('nope.example'), requestFrom('10.0.0.1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses once an address has spent its budget, before it reaches the database', async () => {
    const controller = controllerFor(['help.acme.test']);
    const request = requestFrom('10.0.0.9');

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await controller.check(query('help.acme.test'), request);
    }

    const rejection = await controller.check(query('help.acme.test'), request).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(HttpException);
    expect((rejection as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('keeps one address from spending another address budget', async () => {
    const controller = controllerFor(['help.acme.test']);

    for (let attempt = 0; attempt < 61; attempt += 1) {
      await controller
        .check(query('help.acme.test'), requestFrom('10.0.0.9'))
        .catch(() => undefined);
    }

    await expect(
      controller.check(query('help.acme.test'), requestFrom('10.0.0.10')),
    ).resolves.toEqual({ domain: 'help.acme.test' });
  });
});

describe('domainCheckQuerySchema', () => {
  it('normalises the case and the trailing dot a ServerName may carry', () => {
    expect(query('HELP.Acme.TEST.')).toEqual({ domain: 'help.acme.test' });
  });

  it.each([
    'not a domain',
    'localhost',
    '-leading.example',
    'trailing-.example',
    'help..example',
    'help.acme.test/../etc',
    'hëlp.acme.test',
    `${'a'.repeat(250)}.example.test`,
  ])('refuses %s', (domain) => {
    expect(domainCheckQuerySchema.safeParse({ domain }).success).toBe(false);
  });
});
