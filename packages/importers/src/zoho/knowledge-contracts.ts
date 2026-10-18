import { z } from 'zod';
import { zohoIdSchema } from './contracts.js';

export const zohoKnowledgeStatusSchema = z.enum([
  'SHOW_IN_HELPCENTER',
  'HIDE_IN_HELPCENTER',
  'DISABLED',
]);
const sourceFlag = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);
export const zohoKnowledgeIndexSchema = z.object({
  id: zohoIdSchema,
  status: zohoKnowledgeStatusSchema,
  isTrashed: sourceFlag,
});
const translation = z.object({
  id: zohoIdSchema,
  categoryId: zohoIdSchema,
  locale: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{1,8})*$/),
  name: z.string().min(1).max(20000),
  description: z.string().max(20000).nullable().optional(),
});
export const zohoRootCategorySchema = zohoKnowledgeIndexSchema.extend({
  name: z.string(),
  visibility: z.enum(['AGENTS', 'GROUP_USERS', 'ALL_USERS', 'PRIVATE_IP', 'NONE']),
  groups: z.array(z.object({ id: zohoIdSchema })).max(10000),
  translations: z.array(translation).max(1000),
  createdTime: z.iso.datetime({ offset: true }),
  modifiedTime: z.iso.datetime({ offset: true }),
});
export const zohoSectionSchema = zohoRootCategorySchema.extend({
  rootCategoryId: zohoIdSchema,
  parentCategoryId: zohoIdSchema,
});
