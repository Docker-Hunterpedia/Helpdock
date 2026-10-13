import { describe, expect, it } from 'vitest';
import { samlNameIdFormat } from './saml.service.js';
import { samlAcsSchema } from './saml-contracts.js';
import { strongSamlSignatures } from './saml-crypto-policy.js';
import { SAML_ASSERTION_NS, samlChild, samlDocument, samlTimestamp } from './saml-xml.js';

describe('SAML boundary controls', () => {
  it.each([
    '<!DOCTYPE x><x/>',
    '<!DOCTYPE x [<!ENTITY e "expanded">]><x>&e;</x>',
    '<x><y></x>',
    '<x>&unknown;</x>',
    '',
  ])('refuses unsafe or malformed XML: %s', (xml) => {
    expect(() => samlDocument(xml)).toThrow();
  });
  it('requires an unambiguous namespace-qualified child', () => {
    const root = samlDocument(
      `<a xmlns="${SAML_ASSERTION_NS}"><Issuer>trusted</Issuer><Issuer>other</Issuer></a>`,
    ).documentElement;
    expect(() => samlChild(root, SAML_ASSERTION_NS, 'Issuer')).toThrow();
    expect(() => samlChild(root, 'urn:attacker', 'Issuer')).toThrow();
  });
  it.each(['', 'not-a-date', '2026-10-13', '2026-02-30T12:00:00Z'])(
    'refuses ambiguous SAML timestamps: %s',
    (raw) => {
      expect(() => samlTimestamp(raw)).toThrow();
    },
  );
  it('accepts UTC timestamps and selects the standard NameID namespaces', () => {
    expect(samlTimestamp('2026-10-13T12:00:00.0000000Z')).toBe(Date.UTC(2026, 9, 13, 12));
    expect(samlTimestamp('2026-10-13T13:00:00+01:00')).toBe(Date.UTC(2026, 9, 13, 12));
    expect(samlNameIdFormat('unspecified')).toBe(
      'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    );
    expect(samlNameIdFormat('persistent')).toBe(
      'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    );
  });
  it('refuses SHA-1 signatures and digests', () => {
    for (const method of ['SignatureMethod', 'DigestMethod']) {
      expect(() =>
        strongSamlSignatures(
          `<x xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:Signature><ds:${method} Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/></ds:Signature></x>`,
        ),
      ).toThrow('sso-signature-algorithm-refused');
    }
  });
  it('requires canonical base64 and an opaque RelayState', () => {
    expect(samlAcsSchema.safeParse({ SAMLResponse: '%%%invalid' }).success).toBe(false);
    expect(
      samlAcsSchema.safeParse({ SAMLResponse: 'eA==', RelayState: '//attacker' }).success,
    ).toBe(false);
  });
});
