import { promisify } from 'node:util';
import { decrypt } from 'xml-encryption';
import { SAML_ASSERTION_NS, SamlFailure, samlChildren, samlDocument } from './saml-xml.js';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const ENC = 'http://www.w3.org/2001/04/xmlenc#';
const SIGNATURES = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
]);
const DIGESTS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);

export function strongSamlSignatures(xml: string) {
  const document = samlDocument(xml);
  for (const signature of Array.from(document.getElementsByTagNameNS(DS, 'Signature'))) {
    for (const node of Array.from(signature.getElementsByTagNameNS(DS, 'SignatureMethod')))
      if (!SIGNATURES.has(node.getAttribute('Algorithm') ?? ''))
        throw new SamlFailure('sso-signature-algorithm-refused');
    for (const node of Array.from(signature.getElementsByTagNameNS(DS, 'DigestMethod')))
      if (!DIGESTS.has(node.getAttribute('Algorithm') ?? ''))
        throw new SamlFailure('sso-signature-algorithm-refused');
  }
  return document;
}

/** Decrypt only authenticated encryption before validation; node-saml also accepts legacy CBC/RSA1.5. */
export async function samlResponseXml(xml: string, privateKey: string) {
  const document = strongSamlSignatures(xml);
  const encrypted = samlChildren(document.documentElement, SAML_ASSERTION_NS, 'EncryptedAssertion');
  if (encrypted.length === 0) return xml;
  const [encryptedAssertion] = encrypted;
  if (
    !encryptedAssertion ||
    encrypted.length !== 1 ||
    samlChildren(document.documentElement, SAML_ASSERTION_NS, 'Assertion').length !== 0
  )
    throw new SamlFailure('sso-assertion-invalid');
  const encryptedDocument = samlDocument(encryptedAssertion.toString());
  const algorithms = Array.from(
    encryptedDocument.getElementsByTagNameNS(ENC, 'EncryptionMethod'),
  ).map((node) => node.getAttribute('Algorithm'));
  if (
    algorithms.length !== 2 ||
    !algorithms.includes('http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p') ||
    !algorithms.some(
      (algorithm) =>
        algorithm === 'http://www.w3.org/2009/xmlenc11#aes256-gcm' ||
        algorithm === 'http://www.w3.org/2009/xmlenc11#aes128-gcm',
    )
  )
    throw new SamlFailure('sso-encryption-algorithm-refused');
  const plaintext = await promisify(decrypt)(encryptedAssertion.toString(), {
    key: privateKey,
    disallowDecryptionWithInsecureAlgorithm: true,
  });
  const assertion = strongSamlSignatures(plaintext).documentElement;
  if (assertion.namespaceURI !== SAML_ASSERTION_NS || assertion.localName !== 'Assertion')
    throw new SamlFailure('sso-assertion-invalid');
  document.documentElement.replaceChild(document.importNode(assertion, true), encryptedAssertion);
  return document.toString();
}
