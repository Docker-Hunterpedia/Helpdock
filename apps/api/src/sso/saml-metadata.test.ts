import { describe, expect, it } from 'vitest';
import { samlResponseXml } from './saml-crypto-policy.js';
import { samlMetadataCertificates } from './saml-metadata.js';

const config = {
  idpEntityId: 'https://identity.example.com',
  idpSsoUrl: 'https://identity.example.com/sso',
};
const metadata = (entity: string, descriptor: string) =>
  `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entity}">${descriptor}</EntityDescriptor>`;

describe('SAML metadata authority and algorithm policy', () => {
  it.each([
    metadata('https://attacker.example', ''),
    metadata(config.idpEntityId, '<IDPSSODescriptor protocolSupportEnumeration="urn:attacker"/>'),
    metadata(
      config.idpEntityId,
      '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/>',
    ),
    metadata(
      config.idpEntityId,
      '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://attacker.example/sso"/></IDPSSODescriptor>',
    ),
    metadata(
      config.idpEntityId,
      `<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${config.idpSsoUrl}"/></IDPSSODescriptor>`,
    ),
  ])('refuses metadata that cannot establish the configured IdP authority', (xml) => {
    expect(() => samlMetadataCertificates(xml, config)).toThrow('sso-metadata-invalid');
  });
  it.each([
    [
      'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
      'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
    ],
    ['http://www.w3.org/2009/xmlenc11#aes256-gcm', 'http://www.w3.org/2001/04/xmlenc#rsa-1_5'],
  ])('refuses legacy encryption before using a private key', async (algorithm, keyAlgorithm) => {
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"><saml:EncryptedAssertion><xenc:EncryptedData><xenc:EncryptionMethod Algorithm="${algorithm}"/><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="${keyAlgorithm}"/></xenc:EncryptedKey></xenc:EncryptedData></saml:EncryptedAssertion></samlp:Response>`;
    await expect(samlResponseXml(xml, 'never-used')).rejects.toThrow(
      'sso-encryption-algorithm-refused',
    );
  });
});
