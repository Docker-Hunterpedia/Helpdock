import { describe, expect, it } from 'vitest';
import { contactIdentityKindSchema, VERIFIABLE_IDENTITY_KINDS } from './contact.js';
import {
  IDENTITY_SOURCE_RULES,
  identitySourceSchema,
  isVerifiedIdentity,
} from './identity-rules.js';

describe('isVerifiedIdentity (DOMAIN-RULES §4.4)', () => {
  it.each([
    ['email', 'email.inbound', true],
    ['email', 'email.magic_link', true],
    ['telegram', 'telegram.bot', true],
    ['external', 'widget.signed', true],
    ['visitor', 'widget.visitor', true],
    ['email', 'widget.form', false],
    ['phone', 'widget.form', false],
    ['email', 'email.cc', false],
    ['email', 'agent', false],
    ['phone', 'import', false],
  ] as const)('a %s from %s is verified: %s', (kind, source, verified) => {
    expect(isVerifiedIdentity(kind, source)).toBe(verified);
  });

  it('never verifies a phone number, whatever the source', () => {
    for (const source of identitySourceSchema.options) {
      if (IDENTITY_SOURCE_RULES[source].kinds.includes('phone')) {
        expect(isVerifiedIdentity('phone', source)).toBe(false);
      }
    }
  });

  it('throws on a kind the source cannot produce, which is a bug at the call site', () => {
    expect(() => isVerifiedIdentity('phone', 'telegram.bot')).toThrow(TypeError);
    expect(() => isVerifiedIdentity('email', 'widget.signed')).toThrow(TypeError);
  });

  it('verifies exactly the kinds VERIFIABLE_IDENTITY_KINDS says can be verified', () => {
    const provable = new Set(
      identitySourceSchema.options
        .filter((source) => IDENTITY_SOURCE_RULES[source].verified)
        .flatMap((source) => IDENTITY_SOURCE_RULES[source].kinds),
    );

    for (const kind of contactIdentityKindSchema.options) {
      expect(provable.has(kind)).toBe(VERIFIABLE_IDENTITY_KINDS[kind]);
    }
  });
});
