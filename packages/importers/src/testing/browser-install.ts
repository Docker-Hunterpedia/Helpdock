import { z } from 'zod';

const localUrl = (protocols: string[]) =>
  z.url().refine((raw) => {
    const url = new URL(raw);
    return (
      protocols.includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  });

/** Private IPC between the browser fixture and its disposable API process. */
export const importBrowserInstallSchema = z.strictObject({
  databaseUrl: localUrl(['postgres:', 'postgresql:']).refine(
    (raw) => new URL(raw).username === 'helpdock_app',
  ),
  migrationUrl: localUrl(['postgres:', 'postgresql:']),
  redisUrl: localUrl(['redis:', 'rediss:']),
  webOrigin: localUrl(['http:']),
  apiPort: z.int().min(1024).max(65535),
  directory: z.string().min(1).max(1000),
  controlKey: z.string().regex(/^[0-9a-f]{64}$/),
});

export const importBrowserReadySchema = z.strictObject({
  type: z.literal('ready'),
  brandId: z.uuid(),
  userId: z.uuid(),
  departmentId: z.uuid(),
  tagId: z.uuid(),
  email: z.email(),
  password: z.string().min(12),
  totpSecret: z.string().min(1),
  controlOrigin: localUrl(['http:']),
});
export const importBrowserCloseSchema = z.strictObject({ type: z.literal('close') });
const counter = z.int().nonnegative();
export const importBrowserSnapshotSchema = z.strictObject({
  tickets: counter,
  messages: counter,
  files: counter,
  retained_credentials: counter,
  managedBytesMatch: z.boolean(),
  sourceReadOnly: z.boolean(),
  unexpectedOutbox: counter,
  sends: z.strictObject({ smtp: counter, webhook: counter, telegram: counter, graph: counter }),
  inert: z.strictObject({
    workflow_runs: counter,
    ticket_sla_clocks: counter,
    notifications: counter,
    ai_calls: counter,
    webhook_deliveries: counter,
  }),
});
export type ImportBrowserInstall = z.infer<typeof importBrowserInstallSchema>;
export type ImportBrowserReady = z.infer<typeof importBrowserReadySchema>;
