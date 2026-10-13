import type { DbTransaction } from '@helpdock/db';
import { isVerifiedIdentity } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { ContactFailure } from './contact-failure.js';
import {
  assertVerifiable,
  attachVerifiedIdentity,
  planVerifiedAttach,
  requireNormalised,
} from './identity.js';

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
  it.each([
    'email',
    'telegram',
    'external',
    'visitor',
    'phone',
    'whatsapp',
    'messenger',
    'instagram',
  ] as const)('lets a caller prove a %s identifier', (kind) => {
    expect(() => {
      assertVerifiable(kind, true);
    }).not.toThrow();
  });

  it('allows a phone number to be proven by kind, since WhatsApp can (M10); the source decides', () => {
    expect(() => {
      assertVerifiable('phone', true);
    }).not.toThrow();
    expect(isVerifiedIdentity('phone', 'agent')).toBe(false);
    expect(isVerifiedIdentity('phone', 'whatsapp.cloud')).toBe(true);
  });

  it('allows an unverified phone number, which is what an agent typing one makes', () => {
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

describe('planVerifiedAttach (M10-03)', () => {
  const MINE = 'contact-mine';
  const THEIRS = 'contact-theirs';

  it.each([
    ['nobody holds it', undefined, 'attach'],
    ['it is mine and proven', { contactId: MINE, verified: true }, 'unchanged'],
    ['it is mine and typed', { contactId: MINE, verified: false }, 'verify'],
    ['another contact typed it', { contactId: THEIRS, verified: false }, 'move'],
    ['another contact proved it', { contactId: THEIRS, verified: true }, 'suggest'],
  ] as const)('when %s, the plan is %s', (_case, holder, plan) => {
    expect(planVerifiedAttach(holder, MINE)).toBe(plan);
  });
});

describe('attachVerifiedIdentity (M10-03)', () => {
  // Both refusals come before the first statement, so no transaction is needed;
  // the rows it writes are proved against Postgres in `meta.integration.test.ts`.
  const noTransaction = undefined as unknown as DbTransaction;

  it('takes only an identifier a channel proved, never one an agent typed', async () => {
    await expect(
      attachVerifiedIdentity(noTransaction, 'brand', 'contact', {
        kind: 'phone',
        value: '+16505551234',
        source: 'agent',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('refuses a source that cannot produce the kind, as the rest of the seam does', async () => {
    await expect(
      attachVerifiedIdentity(noTransaction, 'brand', 'contact', {
        kind: 'phone',
        value: '+16505551234',
        source: 'telegram.bot',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('refuses a number that is not international before it looks anything up', async () => {
    await expect(
      attachVerifiedIdentity(noTransaction, 'brand', 'contact', {
        kind: 'phone',
        value: '650 555 1234',
        source: 'whatsapp.cloud',
      }),
    ).rejects.toThrow(ContactFailure);
  });
});
