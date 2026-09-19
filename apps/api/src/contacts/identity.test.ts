import { describe, expect, it } from 'vitest';
import { ContactFailure } from './contact-failure.js';
import { assertVerifiable, requireNormalised } from './identity.js';

/**
 * The parts of the seam that need no database. `findOrCreateContactByIdentity`
 * itself is exercised against a real Postgres in `contacts.integration.test.ts`,
 * because what it promises is about rows and a unique index, and a stubbed
 * transaction would only prove that the stub agrees with itself.
 */

describe('requireNormalised', () => {
  it('returns the normalised value', () => {
    expect(requireNormalised('email', 'Mona@Example.com')).toBe('mona@example.com');
  });

  it('throws a refusal the filter turns into a 400, naming how it was wrong', () => {
    expect(() => requireNormalised('email', 'mona')).toThrow(ContactFailure);

    try {
      requireNormalised('email', 'mona');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'identity-invalid', problem: 'invalid-email' });
    }
  });

  it('passes the brand calling code to a phone number', () => {
    expect(requireNormalised('phone', '030 1234567', '49')).toBe('+49301234567');
  });

  it('refuses a national number when no calling code was given', () => {
    try {
      requireNormalised('phone', '030 1234567');
    } catch (error) {
      expect(error).toMatchObject({ problem: 'phone-not-international' });
    }

    expect.assertions(1);
  });
});

describe('assertVerifiable', () => {
  it.each(['email', 'telegram', 'external', 'visitor'] as const)(
    'lets a caller prove a %s identifier',
    (kind) => {
      expect(() => {
        assertVerifiable(kind, true);
      }).not.toThrow();
    },
  );

  it('refuses a verified phone number, which nothing in v1 can prove', () => {
    expect(() => {
      assertVerifiable('phone', true);
    }).toThrow(TypeError);
  });

  it('allows an unverified phone number, which is the only kind there is', () => {
    expect(() => {
      assertVerifiable('phone', false);
    }).not.toThrow();
  });
});

describe('ContactFailure', () => {
  it('maps each refusal to the status the screen expects', () => {
    expect(new ContactFailure('identity-taken').getStatus()).toBe(409);
    expect(new ContactFailure('identity-invalid', 'empty').getStatus()).toBe(400);
    expect(new ContactFailure('anonymise-forbidden').getStatus()).toBe(403);
  });

  it('never repeats the identifier that was refused', () => {
    expect(new ContactFailure('identity-taken').message).not.toContain('@');
  });
});
