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
    ['whatsapp', 'whatsapp.cloud', true],
    ['phone', 'whatsapp.cloud', true],
    ['messenger', 'messenger.page', true],
    ['instagram', 'instagram.account', true],
    ['external', 'widget.signed', true],
    ['visitor', 'widget.visitor', true],
    ['email', 'widget.form', false],
    ['phone', 'widget.form', false],
    ['email', 'web.form', false],
    ['email', 'email.cc', false],
    ['email', 'agent', false],
    ['phone', 'import', false],
  ] as const)('a %s from %s is verified: %s', (kind, source, verified) => {
    expect(isVerifiedIdentity(kind, source)).toBe(verified);
  });

  it('verifies a phone number through the WhatsApp source alone (DOMAIN-RULES §4.4)', () => {
    const verifying = identitySourceSchema.options.filter(
      (source) =>
        IDENTITY_SOURCE_RULES[source].kinds.includes('phone') &&
        isVerifiedIdentity('phone', source),
    );

    expect(verifying).toEqual(['whatsapp.cloud']);
  });

  it('never lets an agent or an import claim a Meta identifier as verified', () => {
    for (const kind of ['whatsapp', 'messenger', 'instagram', 'phone'] as const) {
      expect(isVerifiedIdentity(kind, 'agent')).toBe(false);
      expect(isVerifiedIdentity(kind, 'import')).toBe(false);
    }
  });

  it('keeps each Meta source to the kinds its platform can produce', () => {
    expect(IDENTITY_SOURCE_RULES['whatsapp.cloud'].kinds).toEqual(['whatsapp', 'phone']);
    expect(IDENTITY_SOURCE_RULES['messenger.page'].kinds).toEqual(['messenger']);
    expect(IDENTITY_SOURCE_RULES['instagram.account'].kinds).toEqual(['instagram']);
    expect(() => isVerifiedIdentity('phone', 'messenger.page')).toThrow(TypeError);
    expect(() => isVerifiedIdentity('whatsapp', 'instagram.account')).toThrow(TypeError);
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
