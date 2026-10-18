import { z } from 'zod';

export const nativeReferenceWorkerConfigSchema = z.strictObject({
  databaseUrl: z.url(),
  redisUrl: z.url(),
  queueName: z.string().regex(/^[\w.-]+$/),
  mediaQueueName: z.string().regex(/^[\w.-]+$/),
  directory: z.string().min(1),
  masterKey: z.string().min(1),
  apiRoot: z.url().refine((raw) => {
    const url = new URL(raw);
    return url.hostname === '127.0.0.1' && url.protocol === 'http:';
  }),
});

export type NativeReferenceWorkerConfig = z.infer<typeof nativeReferenceWorkerConfigSchema>;
export const nativeReferenceWorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({ type: z.literal('failed'), job: z.string(), error: z.string() }),
]);
export const nativeReferenceWorkerCloseSchema = z.strictObject({ type: z.literal('close') });
