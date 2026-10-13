import { DOMParser, type Element } from '@xmldom/xmldom';
import { z } from 'zod';

export const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
export const SAML_PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
export const SAML_METADATA_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';

export class SamlFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SamlFailure';
  }
}

export function samlDocument(xml: string) {
  z.string()
    .min(1)
    .max(256 * 1024)
    .parse(xml);
  if (Buffer.byteLength(xml) > 256 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new SamlFailure('sso-xml-invalid');
  const refuse = () => {
    throw new SamlFailure('sso-xml-invalid');
  };
  const document = new DOMParser({ onError: refuse }).parseFromString(xml, 'text/xml');
  if (!document.documentElement) throw new SamlFailure('sso-xml-invalid');
  return document as typeof document & { documentElement: Element };
}

export function samlChildren(parent: Element, namespace: string, name: string): Element[] {
  const children: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1) {
      const child = node as Element;
      if (child.namespaceURI === namespace && child.localName === name) children.push(child);
    }
  return children;
}

export function samlChild(parent: Element, namespace: string, name: string): Element {
  const children = samlChildren(parent, namespace, name);
  const [child] = children;
  if (children.length !== 1 || !child) throw new SamlFailure('sso-xml-invalid');
  return child;
}

export function samlTimestamp(raw: string | null): number {
  const parsed = z.iso.datetime({ offset: true }).safeParse(raw);
  if (!parsed.success) throw new SamlFailure('sso-time-invalid');
  const timestamp = Date.parse(parsed.data);
  if (!Number.isFinite(timestamp)) throw new SamlFailure('sso-time-invalid');
  return timestamp;
}
