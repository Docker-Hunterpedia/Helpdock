import { z } from 'zod';
import { importEntitySchema, importSourceSchema } from './import.js';

export const importRunParamSchema = z.strictObject({ brandId: z.uuid(), runId: z.uuid() });
export const importBrandParamSchema = z.strictObject({ brandId: z.uuid() });
export const importRunCreateSchema = z
  .strictObject({
    source: importSourceSchema,
    mode: z.enum(['full', 'delta']).default('full'),
    parentRunId: z.uuid().optional(),
  })
  .refine(
    (input) =>
      input.mode === 'delta' ? input.parentRunId !== undefined : input.parentRunId === undefined,
    { message: 'import.parent-invalid' },
  );
export const importDownloadHostSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((host) => {
    const url = URL.parse(`https://${host}`);
    return url !== null && url.hostname === host && !host.includes('..');
  });
const subdomain = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const zendeskCredentialsSchema = z.discriminatedUnion('auth', [
  z.strictObject({ auth: z.literal('oauth'), subdomain, accessToken: z.string().min(1).max(8192) }),
  z.strictObject({
    auth: z.literal('api_token'),
    subdomain,
    email: z.email(),
    apiToken: z.string().min(1).max(8192),
  }),
]);
export type ZendeskCredentials = z.infer<typeof zendeskCredentialsSchema>;
export const importConnectionRequestSchema = z.strictObject({
  credentials: zendeskCredentialsSchema,
  downloadHosts: z.array(importDownloadHostSchema).max(32).default([]),
});
export const importProgressCountsSchema = z.partialRecord(
  importEntitySchema,
  z.int().nonnegative(),
);
export const importScopeSchema = z.strictObject({
  entities: z
    .array(importEntitySchema)
    .min(1)
    .max(importEntitySchema.options.length)
    .default([...importEntitySchema.options])
    .refine((entities) => new Set(entities).size === entities.length, {
      message: 'import.entities-duplicate',
    }),
  rebuildAllReports: z.boolean().default(false),
});
export type ImportScope = z.infer<typeof importScopeSchema>;
export const importRunViewSchema = z.strictObject({
  id: z.uuid(),
  brandId: z.uuid(),
  source: importSourceSchema,
  mode: z.enum(['full', 'delta']),
  parentRunId: z.uuid().nullable(),
  status: z.enum([
    'draft',
    'connecting',
    'extracting',
    'awaiting_mapping',
    'dry_run',
    'ready',
    'loading',
    'finishing',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ]),
  hasCredentials: z.boolean(),
  scope: importScopeSchema,
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  counts: z.strictObject({
    extracted: importProgressCountsSchema,
    loaded: importProgressCountsSchema,
    skipped: importProgressCountsSchema,
  }),
});
export const importRunListSchema = z.strictObject({ runs: z.array(importRunViewSchema).max(100) });
export const importConnectionResultSchema = z.strictObject({
  run: importRunViewSchema,
  account: z.string().min(1).max(200),
});
export type ImportRunView = z.infer<typeof importRunViewSchema>;
export type ImportRunCreate = z.infer<typeof importRunCreateSchema>;
export type ImportConnectionRequest = z.infer<typeof importConnectionRequestSchema>;
