import { TenantContextError } from '@helpdock/db';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TenantScopeError } from '../tenant/tenant-scope.js';
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
  ] as const)('keeps the status of %s', (error, status, code) => {
    const mapped = mapError(error);

    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
    expect(mapped.unexpected).toBe(false);
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
});
