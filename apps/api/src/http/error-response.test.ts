import { TenantContextError } from '@helpdock/db';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { IdentityContentionError } from '../contacts/identity.js';
import { DomainsFailure } from '../domains/domains-failure.js';
import { HelpCenterFailure } from '../help-center/help-center-failure.js';
import { SetupFailure, SetupThrottled } from '../install/setup-failure.js';
import { MetaFailure } from '../meta/meta-failure.js';
import { SsoFailure } from '../sso/sso-failure.js';
import { TenantScopeError } from '../tenant/tenant-scope.js';
import { WebhooksFailure } from '../webhooks/webhooks-failure.js';
import { WidgetFailure } from '../widget/widget-failure.js';
import { errorBody, mapError } from './error-response.js';

const zodErrorFor = (value: unknown) => {
  const result = z.object({ email: z.email(), brandId: z.uuid() }).safeParse(value);
  if (result.success) {
    throw new Error('the fixture must fail validation');
  }
  return result.error;
};

describe('mapError', () => {
  it('turns a failed input schema into a 400 that names the fields', () => {
    const mapped = mapError(new ZodValidationException(zodErrorFor({ email: 'x', brandId: 'y' })));

    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe('validation_failed');
    expect(mapped.fields?.map((field) => field.path).sort()).toEqual(['brandId', 'email']);
    expect(mapped.unexpected).toBe(false);
  });

  it('maps a bare ZodError the same way', () => {
    expect(mapError(zodErrorFor({})).status).toBe(400);
  });

  it('turns a failed output schema into an opaque 500, because that is the api s bug', () => {
    const mapped = mapError(new ZodSerializationException(zodErrorFor({})));

    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe('internal_error');
    expect(mapped.fields).toBeUndefined();
    expect(mapped.message).toBe('The request could not be completed');
    expect(mapped.unexpected).toBe(true);
  });

  it.each([
    [new UnauthorizedException('no'), 401, 'unauthenticated'],
    [new ForbiddenException('no'), 403, 'forbidden'],
    [new NotFoundException('no'), 404, 'not_found'],
    [new BadRequestException('no'), 400, 'validation_failed'],
    [new GoneException('no'), 410, 'gone'],
  ] as const)('keeps the status of %s', (error, status, code) => {
    const mapped = mapError(error);

    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
    expect(mapped.unexpected).toBe(false);
  });

  it('calls a reused Idempotency-Key a conflict, at 422', () => {
    expect(
      mapError(new UnprocessableEntityException('used with a different request')),
    ).toMatchObject({ status: 422, code: 'conflict', unexpected: false });
  });

  it('maps a tenant context the caller built wrongly to 400', () => {
    expect(mapError(new TenantContextError('brandIds', 'must contain UUIDs only')).status).toBe(
      400,
    );
    expect(mapError(new TenantScopeError('the principal holds no brand')).status).toBe(400);
  });

  it('never lets an unexpected error describe itself to the client', () => {
    const mapped = mapError(
      new Error('duplicate key value violates unique constraint "users_email_lower_key"'),
    );

    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe('The request could not be completed');
    expect(mapped.unexpected).toBe(true);
  });

  it('does the same for a thrown non-error', () => {
    expect(mapError('boom').status).toBe(500);
    expect(mapError(undefined).message).toBe('The request could not be completed');
  });
});

describe('a write that keeps losing its race for a contact', () => {
  it('is a retryable 503 with a stable code, not a 500', () => {
    const mapped = mapError(new IdentityContentionError());

    expect(mapped).toMatchObject({
      status: 503,
      code: 'unavailable',
      retryAfter: 1,
      unexpected: false,
    });
  });
});

describe('errorBody', () => {
  it('always carries the request id, which is what an operator greps for', () => {
    const body = errorBody(mapError(new ForbiddenException('no')), 'req-7');

    expect(body).toEqual({
      error: { code: 'forbidden', message: 'no', requestId: 'req-7' },
    });
  });

  it('carries the field list only when there is one', () => {
    const body = errorBody(mapError(new ZodValidationException(zodErrorFor({}))), 'req-8');

    expect(body.error.fields).toHaveLength(2);
  });

  it('carries the ticketing refusal, which is what the screen turns into a sentence', () => {
    const body = errorBody(mapError(new TicketingFailure('last-department')), 'req-9');

    expect(body.error).toMatchObject({
      code: 'conflict',
      requestId: 'req-9',
      ticketing: { reason: 'last-department' },
    });
  });

  it('carries the wizard refusal, which is what step 1 draws under the setup key', () => {
    const body = errorBody(mapError(new SetupFailure('setup-key-invalid')), 'req-10');

    expect(body.error).toMatchObject({
      code: 'forbidden',
      requestId: 'req-10',
      setup: { reason: 'setup-key-invalid' },
    });
  });

  it('asks for the SMTP password again as a field error on the password', () => {
    const body = errorBody(mapError(new SetupFailure('smtp-password-required')), 'req-10b');

    expect(body.error).toMatchObject({
      code: 'validation_failed',
      setup: { reason: 'smtp-password-required' },
      fields: [{ path: 'body.password' }],
    });
  });

  it('maps a throttled setup call to 429 with its Retry-After', () => {
    const mapped = mapError(new SetupThrottled('slow down', 90));

    expect(mapped).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 90 });
  });

  it('carries the custom-domain refusal, which the Domains tab turns into a sentence', () => {
    const body = errorBody(mapError(new DomainsFailure('domain-taken')), 'req-11');

    expect(body.error).toMatchObject({
      code: 'conflict',
      requestId: 'req-11',
      domains: { reason: 'domain-taken' },
    });
  });

  it('carries the Meta refusal and, for a closed reply window, when the window closed', () => {
    const details = {
      platform: 'messenger',
      anchorAt: '2026-10-10T08:00:00.000Z',
      closedAt: '2026-10-11T08:00:00.000Z',
    } as const;
    const closed = errorBody(mapError(new MetaFailure('reply-window-closed', details)), 'req-20');
    const invalid = errorBody(mapError(new MetaFailure('token-invalid')), 'req-21');

    expect(closed.error).toMatchObject({
      code: 'conflict',
      requestId: 'req-20',
      meta: { reason: 'reply-window-closed', details },
    });
    expect(invalid.error).toMatchObject({
      code: 'validation_failed',
      meta: { reason: 'token-invalid' },
    });
    expect(invalid.error.meta).not.toHaveProperty('details');
  });

  it('carries the webhook refusal and the address the name resolved to', () => {
    const blocked = errorBody(
      mapError(new WebhooksFailure('webhook-destination-blocked', '10.0.4.12')),
      'req-12',
    );
    const http = errorBody(mapError(new WebhooksFailure('webhook-https-required')), 'req-13');

    expect(blocked.error).toMatchObject({
      code: 'validation_failed',
      webhooks: { reason: 'webhook-destination-blocked', address: '10.0.4.12' },
    });
    expect(http.error.webhooks).toEqual({ reason: 'webhook-https-required' });
  });

  it('carries the SSO refusal and the email domains another connection lists', () => {
    const taken = errorBody(
      mapError(new SsoFailure('sso-email-domain-taken', ['example.com'])),
      'req-15',
    );
    const certificates = errorBody(
      mapError(new SsoFailure('sso-metadata-confirm-certificates')),
      'req-16',
    );

    expect(taken.error).toMatchObject({
      code: 'conflict',
      sso: { reason: 'sso-email-domain-taken', domains: ['example.com'] },
    });
    expect(certificates.error).toMatchObject({ code: 'validation_failed' });
    expect(certificates.error.sso).toEqual({ reason: 'sso-metadata-confirm-certificates' });
  });

  it('answers a key that may not read a webhook endpoint’s events with 403 and its reason', () => {
    const mapped = mapError(new WebhooksFailure('webhook-event-scope'));

    expect(mapped.status).toBe(403);
    expect(errorBody(mapped, 'req-14').error).toMatchObject({
      code: 'forbidden',
      webhooks: { reason: 'webhook-event-scope' },
    });
  });

  it('carries the help center refusal, with the status its rule answers', () => {
    const conflict = errorBody(mapError(new HelpCenterFailure('slug-taken')), 'req-11');
    const invalid = mapError(new HelpCenterFailure('schedule-in-past'));

    expect(conflict.error).toMatchObject({
      code: 'conflict',
      helpCenter: { reason: 'slug-taken' },
    });
    expect(invalid).toMatchObject({ status: 400, code: 'validation_failed' });
  });
});

describe('a refused ticketing action', () => {
  it('is a permission answer when the department is outside the actor’s scope', () => {
    const mapped = mapError(new TicketingFailure('out-of-scope'));

    expect(mapped).toMatchObject({
      status: 403,
      code: 'forbidden',
      ticketing: { reason: 'out-of-scope' },
    });
    expect(mapped.unexpected).toBe(false);
  });

  it('is a conflict when a rule, not a permission, refused', () => {
    for (const reason of [
      'last-department',
      'department-in-use',
      'name-taken',
      'not-eligible',
    ] as const) {
      expect(mapError(new TicketingFailure(reason)).status).toBe(409);
    }
  });

  it('carries the count a refused status state change would have touched (#361)', () => {
    const body = errorBody(
      mapError(new TicketingFailure('status-change-needs-confirmation', 37)),
      'req-11',
    );

    expect(body.error).toMatchObject({
      code: 'conflict',
      ticketing: { reason: 'status-change-needs-confirmation', count: 37 },
    });
    expect(mapError(new TicketingFailure('status-has-closed-tickets', 3)).status).toBe(409);
  });
});

describe('a refused widget request (M4)', () => {
  it('keeps its reason for the widget to translate', () => {
    const mapped = mapError(new WidgetFailure('origin_not_allowed'));

    expect(mapped).toMatchObject({ status: 403, code: 'forbidden', widget: 'origin_not_allowed' });
    expect(errorBody(mapped, 'req-1').error.widget).toEqual({ reason: 'origin_not_allowed' });
    expect(mapError(new WidgetFailure('rate_limited'))).toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
  });
});
