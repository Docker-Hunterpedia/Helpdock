import type { Profile } from '@node-saml/node-saml';
import { z } from 'zod';
import { ssoAssertionSchema, ssoReturnToSchema } from './oidc-contracts.js';
import {
  SAML_ASSERTION_NS as NS,
  SamlFailure,
  samlChild,
  samlChildren,
  samlDocument,
  samlTimestamp,
} from './saml-xml.js';

export const samlAcsSchema = z
  .object({
    SAMLResponse: z
      .string()
      .min(1)
      .max(256 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    RelayState: z.string().min(16).max(80).optional(),
  })
  .strict();
export const samlCompleteQuerySchema = z.object({ token: z.string().min(32).max(80) });
export const samlRequestSchema = z.object({
  connectionId: z.uuid(),
  configurationHash: z.string().length(64),
  requestId: z.string().min(16).max(256),
  browserNonceHash: z.string().length(64),
  returnTo: ssoReturnToSchema,
  expectedSubject: z.string().min(1).max(1000).optional(),
});
export const samlPendingSchema = z.object({
  connectionId: z.uuid(),
  configurationHash: z.string().length(64),
  assertion: ssoAssertionSchema,
  requestId: z.string().min(16).max(256),
  relayState: z.string().min(16).max(80),
});

type AssertionInput = {
  profile: Profile;
  connectionId: string;
  issuer: string;
  recipient: string;
  emailDomains: string[];
  emailAttribute: string | undefined;
  nameAttribute: string | undefined;
  groupAttribute: string | null;
  skewSeconds: number;
  nameIdFormat: string;
};
type AssertionElement = ReturnType<typeof samlDocument>['documentElement'];

function signedAssertion(profile: Profile) {
  const xml = profile.getAssertionXml?.();
  if (!xml) throw new SamlFailure('sso-assertion-invalid');
  const assertion = samlDocument(xml).documentElement;
  if (
    assertion.namespaceURI !== NS ||
    assertion.localName !== 'Assertion' ||
    assertion.getAttribute('Version') !== '2.0'
  )
    throw new SamlFailure('sso-assertion-invalid');
  return assertion;
}

function assertionTimes(assertion: AssertionElement, skewSeconds: number) {
  const now = Date.now();
  const skew = skewSeconds * 1000;
  const issued = samlTimestamp(assertion.getAttribute('IssueInstant'));
  if (issued > now + skew || issued + 600000 + skew <= now)
    throw new SamlFailure('sso-time-invalid');
  const conditions = samlChild(assertion, NS, 'Conditions');
  const notBefore = samlTimestamp(conditions.getAttribute('NotBefore'));
  const expires = samlTimestamp(conditions.getAttribute('NotOnOrAfter'));
  if (notBefore > now + skew || expires + skew <= now || expires <= notBefore)
    throw new SamlFailure('sso-time-invalid');
}

function assertionSubject(assertion: AssertionElement, input: AssertionInput) {
  const subject = samlChild(assertion, NS, 'Subject');
  const nameId = samlChild(subject, NS, 'NameID');
  if (nameId.getAttribute('Format') !== input.nameIdFormat)
    throw new SamlFailure('sso-subject-invalid');
  const confirmation = samlChild(subject, NS, 'SubjectConfirmation');
  if (confirmation.getAttribute('Method') !== 'urn:oasis:names:tc:SAML:2.0:cm:bearer')
    throw new SamlFailure('sso-recipient-invalid');
  const confirmationData = samlChild(confirmation, NS, 'SubjectConfirmationData');
  if (
    confirmationData.getAttribute('Recipient') !== input.recipient ||
    samlTimestamp(confirmationData.getAttribute('NotOnOrAfter')) + input.skewSeconds * 1000 <=
      Date.now()
  )
    throw new SamlFailure('sso-recipient-invalid');
  const notBefore = confirmationData.getAttribute('NotBefore');
  if (notBefore && samlTimestamp(notBefore) > Date.now() + input.skewSeconds * 1000)
    throw new SamlFailure('sso-time-invalid');
  return {
    subject: nameId.textContent,
    requestId: confirmationData.getAttribute('InResponseTo') || null,
  };
}

function attributeText(value: AssertionElement) {
  for (let child = value.firstChild; child; child = child.nextSibling)
    if (child.nodeType === 1) throw new SamlFailure('sso-attributes-invalid');
  return value.textContent ?? '';
}
function assertionAttributes(assertion: AssertionElement) {
  const attributes = new Map<string, string[]>();
  for (const statement of samlChildren(assertion, NS, 'AttributeStatement'))
    for (const attribute of samlChildren(statement, NS, 'Attribute')) {
      const name = attribute.getAttribute('Name');
      if (!name || attributes.has(name)) throw new SamlFailure('sso-attributes-invalid');
      attributes.set(name, samlChildren(attribute, NS, 'AttributeValue').map(attributeText));
    }
  return attributes;
}
function assertionEmail(
  attributes: Map<string, string[]>,
  subject: string | null,
  input: AssertionInput,
) {
  const emails = input.emailAttribute ? attributes.get(input.emailAttribute) : [subject];
  if (emails?.length !== 1) throw new SamlFailure('sso-email-unverified');
  const email = z.email().parse(emails[0]);
  if (!input.emailDomains.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase()))
    throw new SamlFailure('sso-email-unverified');
  return email;
}

/** Read only the assertion XML returned after node-saml's signature validation. */
export function samlAssertion(input: AssertionInput) {
  const assertion = signedAssertion(input.profile);
  if (samlChild(assertion, NS, 'Issuer').textContent !== input.issuer)
    throw new SamlFailure('sso-issuer-invalid');
  assertionTimes(assertion, input.skewSeconds);
  const identity = assertionSubject(assertion, input);
  const attributes = assertionAttributes(assertion);
  const email = assertionEmail(attributes, identity.subject, input);
  const names = input.nameAttribute ? attributes.get(input.nameAttribute) : undefined;
  if (names && names.length !== 1) throw new SamlFailure('sso-attributes-invalid');
  const groups = input.groupAttribute === null ? [] : attributes.get(input.groupAttribute);
  if (!groups) throw new SamlFailure('sso-groups-unavailable');
  return {
    assertion: ssoAssertionSchema.parse({
      connectionId: input.connectionId,
      subject: identity.subject,
      email,
      emailVerified: true,
      name: names?.[0],
      groups,
    }),
    assertionId: z.string().min(16).max(256).parse(assertion.getAttribute('ID')),
    requestId: identity.requestId,
  };
}
