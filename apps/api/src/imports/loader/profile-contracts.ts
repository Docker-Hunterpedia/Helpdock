import {
  importContactSchema,
  importOrganizationSchema,
  importSourceSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

const profileScopeSchema = z.strictObject({
  brandId: z.uuid(),
  runId: z.uuid(),
  source: importSourceSchema,
});
export const organizationLoadSchema = profileScopeSchema.extend({
  record: importOrganizationSchema,
  custom: z.record(z.string(), z.json()),
});
export const contactLoadSchema = profileScopeSchema.extend({
  record: importContactSchema,
  accountId: z.uuid().nullable(),
  custom: z.record(z.string(), z.json()),
  defaultCallingCode: z
    .string()
    .regex(/^\d{0,4}$/)
    .default(''),
});
export type OrganizationLoad = z.infer<typeof organizationLoadSchema>;
export type ContactLoad = z.infer<typeof contactLoadSchema>;
export type ProfileOutcome = {
  id: string;
  outcome: 'created' | 'linked' | 'updated' | 'unchanged';
};
