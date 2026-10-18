import { X509Certificate } from 'node:crypto';
import type { ssoConnectionConfigSchema } from '@helpdock/schemas';
import { oidcTransport } from './oidc-transport.js';
import { SAML_METADATA_NS as MD, SamlFailure, samlChildren, samlDocument } from './saml-xml.js';

type SamlConfig = Extract<ReturnType<typeof ssoConnectionConfigSchema.parse>, { protocol: 'saml' }>;
const DS = 'http://www.w3.org/2000/09/xmldsig#';

export function samlCertificate(pem: string) {
  const cert = new X509Certificate(pem);
  if (
    cert.publicKey.asymmetricKeyType !== 'rsa' ||
    (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new SamlFailure('sso-invalid-certificate');
  return cert;
}
export const certificateFingerprint = (pem: string) => samlCertificate(pem).fingerprint256;
/** Whether `next` trusts a signing certificate that `current` does not. */
export function addsCertificates(current: string[], next: string[]) {
  const fingerprints = new Set(current.map(certificateFingerprint));
  return next.some((pem) => !fingerprints.has(certificateFingerprint(pem)));
}

function metadataIdpDescriptor(xml: string, config: Pick<SamlConfig, 'idpEntityId' | 'idpSsoUrl'>) {
  const root = samlDocument(xml).documentElement;
  const entities =
    root.namespaceURI === MD && root.localName === 'EntityDescriptor'
      ? [root]
      : samlChildren(root, MD, 'EntityDescriptor');
  const matched = entities.filter(
    (entity) => entity.getAttribute('entityID') === config.idpEntityId,
  );
  const [entity] = matched;
  if (matched.length !== 1 || !entity) throw new SamlFailure('sso-metadata-invalid');
  const descriptors = samlChildren(entity, MD, 'IDPSSODescriptor').filter((descriptor) =>
    (descriptor.getAttribute('protocolSupportEnumeration') ?? '')
      .split(/\s+/)
      .includes('urn:oasis:names:tc:SAML:2.0:protocol'),
  );
  const [descriptor] = descriptors;
  if (descriptors.length !== 1 || !descriptor) throw new SamlFailure('sso-metadata-invalid');
  if (
    !samlChildren(descriptor, MD, 'SingleSignOnService').some(
      (endpoint) =>
        endpoint.getAttribute('Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect' &&
        endpoint.getAttribute('Location') === config.idpSsoUrl,
    )
  )
    throw new SamlFailure('sso-metadata-invalid');
  return descriptor;
}

function signingCertificates(descriptor: ReturnType<typeof metadataIdpDescriptor>) {
  const certificates: string[] = [];
  for (const key of samlChildren(descriptor, MD, 'KeyDescriptor')) {
    if (key.hasAttribute('use') && key.getAttribute('use') !== 'signing') continue;
    for (const keyInfo of samlChildren(key, DS, 'KeyInfo'))
      for (const data of samlChildren(keyInfo, DS, 'X509Data'))
        for (const certificate of samlChildren(data, DS, 'X509Certificate')) {
          const raw = (certificate.textContent ?? '').replace(/\s+/g, '');
          if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
            throw new SamlFailure('sso-metadata-invalid');
          const pem = `-----BEGIN CERTIFICATE-----\n${raw.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
          certificates.push(samlCertificate(pem).toString());
        }
  }
  return certificates;
}

export function samlMetadataCertificates(
  xml: string,
  config: Pick<SamlConfig, 'idpEntityId' | 'idpSsoUrl'>,
) {
  const certificates = signingCertificates(metadataIdpDescriptor(xml, config));
  const unique = [
    ...new Map(certificates.map((pem) => [certificateFingerprint(pem), pem])).values(),
  ];
  if (unique.length < 1 || unique.length > 3) throw new SamlFailure('sso-metadata-invalid');
  return unique;
}

export async function fetchSamlMetadata(config: SamlConfig, allowCidrs: readonly string[]) {
  if (!config.idpMetadataUrl) throw new SamlFailure('sso-metadata-invalid');
  const response = await oidcTransport(allowCidrs)(config.idpMetadataUrl, {
    method: 'GET',
    body: undefined,
    redirect: 'manual',
    headers: { accept: 'application/samlmetadata+xml, application/xml' },
  });
  if (!response.ok) throw new SamlFailure('sso-metadata-unavailable');
  return samlMetadataCertificates(await response.text(), config);
}
