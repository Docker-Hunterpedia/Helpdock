import { hashImportValue } from '@helpdock/importers';
import { z } from 'zod';
import type { previewImportedContactSource } from './contact-source-plan.js';
import type { previewImportedOrganization } from './organization-plan.js';

export const importIdentityProjectionSchema = z.strictObject({
  version: z.literal(1),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  destination: z.string().min(1).max(204),
  claims: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(200),
});

export function contactIdentityProjection(request: {
  externalId: string;
  inputHash: string;
  plan: Awaited<ReturnType<typeof previewImportedContactSource>>;
}) {
  const { externalId, inputHash, plan } = request;
  return importIdentityProjectionSchema.parse({
    version: 1,
    inputHash,
    destination: plan.contactId
      ? `existing:${plan.contactId}`
      : `new:${hashImportValue({ externalId })}`,
    claims:
      plan.action === 'unchanged'
        ? []
        : plan.identifiers.map((identity) => hashImportValue(identity)),
  });
}

export function organizationIdentityProjection(request: {
  externalId: string;
  inputHash: string;
  plan: Awaited<ReturnType<typeof previewImportedOrganization>>;
}) {
  const { externalId, inputHash, plan } = request;
  return importIdentityProjectionSchema.parse({
    version: 1,
    inputHash,
    destination: plan.accountId
      ? `existing:${plan.accountId}`
      : `new:${hashImportValue({ externalId })}`,
    claims:
      plan.action === 'unchanged' ? [] : plan.domains.map((domain) => hashImportValue({ domain })),
  });
}
