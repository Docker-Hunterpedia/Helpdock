import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PayloadValidationError, parsePayload } from './validation.js';

const schema = z.object({ brandId: z.uuid(), token: z.string().min(8) });

describe('parsePayload', () => {
  it('returns the parsed value', () => {
    const value = parsePayload('test payload', schema, {
      brandId: '00000000-0000-7000-8000-000000000001',
      token: 'long-enough',
    });

    expect(value.token).toBe('long-enough');
  });

  it('names the subject and every issue that failed', () => {
    expect(() => parsePayload('test payload', schema, { brandId: 'nope', token: 'short' })).toThrow(
      PayloadValidationError,
    );

    try {
      parsePayload('test payload', schema, { brandId: 'nope', token: 'short' });
    } catch (error) {
      const issues = (error as PayloadValidationError).issues;
      expect(issues.map((issue) => issue.path)).toEqual(['brandId', 'token']);
      expect((error as Error).message).toContain('Invalid test payload');
    }
  });

  it('never puts the rejected value in the message, because a payload can carry customer data', () => {
    try {
      parsePayload('test payload', schema, {
        brandId: 'sensitive@example.com',
        token: 'hunter2!',
      });
    } catch (error) {
      expect((error as Error).message).not.toContain('sensitive@example.com');
    }
  });

  it('calls an issue on the payload itself `(root)`', () => {
    try {
      parsePayload('test payload', z.string(), 42);
    } catch (error) {
      expect((error as PayloadValidationError).issues[0]?.path).toBe('(root)');
    }
  });
});
