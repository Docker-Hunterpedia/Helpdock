import 'reflect-metadata';
import { createPrivateKey, randomBytes, verify, webcrypto, X509Certificate } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { X509CertificateGenerator } from '@peculiar/x509';
import { SignedXml } from 'xml-crypto';
import { encrypt } from 'xml-encryption';

const xmlEscape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
async function signingKey() {
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: 'CN=Fake SAML IdP',
    notBefore: new Date(Date.now() - 60000),
    notAfter: new Date(Date.now() + 86400000),
    keys,
    signingAlgorithm: algorithm,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    certificate: cert.toString('pem'),
    privateKey: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}

/** Signed local IdP responses; the redirect signature is verified against the actual SP certificate. */
export async function fakeSamlIdp() {
  const [key, rotated, stranger] = await Promise.all([signingKey(), signingKey(), signingKey()]);
  const issuer = 'http://127.0.0.1:8443';
  const controls = {
    unsigned: false,
    unknownCert: false,
    rotated: false,
    wrongIssuer: false,
    wrongAudience: false,
    wrongRecipient: false,
    expired: false,
    future: false,
    missingTimes: false,
    missingGroups: false,
    duplicateAttribute: false,
    wrapping: false,
    metadataCertificates: [key.certificate],
    metadataEntityId: issuer,
    metadataStatus: 200,
    groups: ['Support'],
    subject: 'staff-1',
    email: 'ada@example.com',
    spCertificate: '',
  };
  const reset = () =>
    Object.assign(controls, {
      unsigned: false,
      unknownCert: false,
      rotated: false,
      wrongIssuer: false,
      wrongAudience: false,
      wrongRecipient: false,
      expired: false,
      future: false,
      missingTimes: false,
      missingGroups: false,
      duplicateAttribute: false,
      wrapping: false,
      metadataCertificates: [key.certificate],
      metadataEntityId: issuer,
      metadataStatus: 200,
      groups: ['Support'],
      subject: 'staff-1',
      email: 'ada@example.com',
    });
  const response = (input: { requestId?: string; recipient: string; audience: string }) => {
    const id = `_${randomBytes(24).toString('hex')}`;
    const now = Date.now();
    const before = new Date(now + (controls.future ? 300000 : -60000)).toISOString();
    const after = new Date(now + (controls.expired ? -300000 : 300000)).toISOString();
    const correlation = input.requestId ? ` InResponseTo="${xmlEscape(input.requestId)}"` : '';
    const attribute = (name: string, values: string[]) =>
      `<saml:Attribute Name="${name}">${values.map((value) => `<saml:AttributeValue>${xmlEscape(value)}</saml:AttributeValue>`).join('')}</saml:Attribute>`;
    let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date(now).toISOString()}"><saml:Issuer>${xmlEscape(controls.wrongIssuer ? 'wrong-idp' : issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${xmlEscape(controls.subject)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="${xmlEscape(controls.wrongRecipient ? 'https://attacker.example/acs' : input.recipient)}" NotOnOrAfter="${after}"${correlation}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions${controls.missingTimes ? '' : ` NotBefore="${before}" NotOnOrAfter="${after}"`}><saml:AudienceRestriction><saml:Audience>${xmlEscape(controls.wrongAudience ? 'wrong-audience' : input.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attribute('email', [controls.email])}${attribute('name', ['Ada'])}${controls.missingGroups ? '' : attribute('groups', controls.groups)}${controls.duplicateAttribute ? attribute('email', ['attacker@example.com']) : ''}</saml:AttributeStatement></saml:Assertion>`;
    if (!controls.unsigned) {
      const signing = controls.unknownCert ? stranger : controls.rotated ? rotated : key;
      const signature = new SignedXml({
        privateKey: signing.privateKey,
        publicCert: signing.certificate,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      signature.addReference({
        xpath: "/*[local-name()='Assertion']",
        transforms: [
          'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
          'http://www.w3.org/2001/10/xml-exc-c14n#',
        ],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      signature.computeSignature(assertion, {
        location: {
          reference: "/*[local-name()='Assertion']/*[local-name()='Issuer']",
          action: 'after',
        },
      });
      assertion = signature.getSignedXml();
    }
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomBytes(24).toString('hex')}" Version="2.0" IssueInstant="${new Date(now).toISOString()}" Destination="${xmlEscape(input.recipient)}"${correlation}><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}${controls.wrapping ? assertion.replace('staff-1', 'attacker') : ''}</samlp:Response>`;
    return Buffer.from(xml).toString('base64');
  };
  const authorize = (url: string) => {
    const params = new URL(url).searchParams;
    const signed = `SAMLRequest=${encodeURIComponent(params.get('SAMLRequest') ?? '')}&RelayState=${encodeURIComponent(params.get('RelayState') ?? '')}&SigAlg=${encodeURIComponent(params.get('SigAlg') ?? '')}`;
    if (
      params.get('SigAlg') !== 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' ||
      !verify(
        'RSA-SHA256',
        Buffer.from(signed),
        controls.spCertificate,
        Buffer.from(params.get('Signature') ?? '', 'base64'),
      )
    )
      throw new Error('AuthnRequest signature invalid');
    const xml = inflateRawSync(Buffer.from(params.get('SAMLRequest') ?? '', 'base64')).toString();
    const requestId = /\bID="([^"]+)"/.exec(xml)?.[1];
    const recipient = /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1];
    const audience = /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/.exec(xml)?.[1];
    if (!requestId || !recipient || !audience) throw new Error('AuthnRequest missing fields');
    return {
      recipient,
      SAMLResponse: response({ requestId, recipient, audience }),
      RelayState: params.get('RelayState') ?? '',
      requestId,
    };
  };
  const encryptedResponse = async (
    input: { requestId?: string; recipient: string; audience: string },
    spCertificate: string,
  ) => {
    const xml = Buffer.from(response(input), 'base64').toString();
    const assertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)?.[0];
    if (!assertion) throw new Error('Missing assertion fixture');
    const encrypted = await new Promise<string>((resolve, reject) =>
      encrypt(
        assertion,
        {
          rsa_pub: new X509Certificate(spCertificate).publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
          pem: spCertificate,
          encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
          keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
          disallowEncryptionWithInsecureAlgorithm: true,
        },
        (error, encrypted) => (error ? reject(error) : resolve(encrypted)),
      ),
    );
    return Buffer.from(
      xml.replace(
        assertion,
        `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encrypted}</saml:EncryptedAssertion>`,
      ),
    ).toString('base64');
  };
  const handlers: Record<string, (request: IncomingMessage, reply: ServerResponse) => void> = {
    '/metadata': (_request, reply) => {
      reply.writeHead(controls.metadataStatus, {
        'content-type': 'application/samlmetadata+xml',
      });
      reply.end(
        `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${xmlEscape(controls.metadataEntityId)}"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${controls.metadataCertificates.map((certificate) => `<KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificate.replace(/-----[^-]+-----|\s/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>`).join('')}<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${issuer}/sso"/></IDPSSODescriptor></EntityDescriptor>`,
      );
    },
    '/sso': (request, reply) => {
      const issued = authorize(new URL(request.url ?? '/', issuer).toString());
      reply.writeHead(200, { 'content-type': 'text/html' });
      reply.end(
        `<html><body><form method="POST" action="${xmlEscape(issued.recipient)}"><input name="SAMLResponse" value="${xmlEscape(issued.SAMLResponse)}"><input name="RelayState" value="${xmlEscape(issued.RelayState)}"></form><script>document.forms[0].submit()</script></body></html>`,
      );
    },
  };
  const server = createServer((request, reply) => {
    const handler = handlers[new URL(request.url ?? '/', issuer).pathname];
    if (!handler) {
      reply.writeHead(404);
      reply.end();
      return;
    }
    try {
      handler(request, reply);
    } catch {
      reply.writeHead(400);
      reply.end('Invalid test request');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(8443, '127.0.0.1', resolve);
  });
  return {
    issuer,
    certificate: key.certificate,
    rotatedCertificate: rotated.certificate,
    controls,
    reset,
    response,
    encryptedResponse,
    authorize,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
