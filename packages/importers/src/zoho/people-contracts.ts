import { z } from 'zod';
import { zohoIdSchema } from './contracts.js';

const text = z.string().nullable().optional();
const profile = z.object({
  id: zohoIdSchema,
  createdTime: z.iso.datetime({ offset: true }),
  modifiedTime: z.iso.datetime({ offset: true }),
  cf: z.record(z.string(), z.json()).default({}),
  description: text,
  isDeleted: z.boolean().optional(),
  isTrashed: z.boolean().optional(),
  country: text,
  city: text,
  state: text,
  street: text,
  zip: text,
  ownerId: zohoIdSchema.nullable().optional(),
});
export const zohoContactSchema = profile.extend({
  firstName: text,
  lastName: z.string(),
  email: text,
  secondaryEmail: text,
  phone: text,
  mobile: text,
  accountId: zohoIdSchema.nullable().optional(),
  language: text,
  type: text,
  title: text,
  twitter: text,
  facebook: text,
  isSpam: z.boolean().optional(),
  isAnonymous: z.boolean().optional(),
  zohoCRMContact: z.object({ id: zohoIdSchema, type: z.string().optional() }).nullable().optional(),
});
export const zohoAccountSchema = profile.extend({
  accountName: z.string(),
  website: text,
  email: text,
  phone: text,
  fax: text,
  code: text,
  industry: text,
  annualrevenue: z
    .union([
      z.string(),
      z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    ])
    .nullable()
    .optional(),
  zohoCRMAccount: z.object({ id: zohoIdSchema }).nullable().optional(),
  associatedSLAIds: z
    .array(z.union([zohoIdSchema, z.number().int().positive().safe()]))
    .max(1000)
    .optional(),
});
export const zohoAgentSchema = z.object({
  id: zohoIdSchema,
  name: text,
  firstName: text,
  lastName: z.string(),
  emailId: text,
  phone: text,
  status: z.enum(['ACTIVE', 'DISABLED', 'DELETED', 'IMPORTED']),
  associatedDepartmentIds: z.array(zohoIdSchema).max(1000),
  rolePermissionType: z.string(),
});
export const zohoDepartmentSchema = z.object({
  id: zohoIdSchema,
  name: z.string(),
  isEnabled: z.boolean(),
});
