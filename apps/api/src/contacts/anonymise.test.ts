import { describe, expect, it } from 'vitest';
import { erasedIdentityValue, erasureSummary } from './anonymise.js';

const CONTACT = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const OTHER = '0192c3f0-1a2b-7c3d-8e4f-000000000002';

describe('erasedIdentityValue', () => {
  it('replaces the identifier with a digest that names only its kind', () => {
    const erased = erasedIdentityValue(CONTACT, 'email');

    expect(erased).toMatch(/^erased:email:[\da-f]{32}$/);
  });

  it('is stable for one contact, so an erasure can be repeated safely', () => {
    expect(erasedIdentityValue(CONTACT, 'phone')).toBe(erasedIdentityValue(CONTACT, 'phone'));
  });

  it('differs per contact, so two erased addresses cannot be matched to each other', () => {
    expect(erasedIdentityValue(CONTACT, 'email')).not.toBe(erasedIdentityValue(OTHER, 'email'));
  });

  it('differs per kind, so one contact keeps the unique index satisfied', () => {
    expect(erasedIdentityValue(CONTACT, 'email')).not.toBe(erasedIdentityValue(CONTACT, 'phone'));
  });

  it('never carries the value it replaced', () => {
    // Derived from the contact id alone: an attacker holding the digest cannot
    // confirm a guessed address by hashing it.
    expect(erasedIdentityValue(CONTACT, 'email')).not.toContain('@');
  });
});

describe('erasureSummary', () => {
  it('counts what went and names no value of any kind', () => {
    const summary = erasureSummary({
      kinds: ['email', 'phone', 'email'],
      noteCount: 2,
      hadAccount: true,
      hadExternalId: false,
    });

    expect(summary).toEqual({
      identityCount: 3,
      kinds: ['email', 'phone'],
      noteCount: 2,
      hadAccount: true,
      hadExternalId: false,
    });
  });

  it('is empty-safe for a contact nobody ever reached', () => {
    expect(
      erasureSummary({ kinds: [], noteCount: 0, hadAccount: false, hadExternalId: false }),
    ).toMatchObject({ identityCount: 0, kinds: [] });
  });
});
