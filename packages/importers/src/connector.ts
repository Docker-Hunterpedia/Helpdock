import type { Readable } from 'node:stream';
import type {
  ImportAttachmentRef,
  ImportEntity,
  ImportRecord,
  ImportSource,
} from '@helpdock/schemas';
import type { z } from 'zod';
import type { ImportHttp } from './http.js';

type JsonValue = z.infer<ReturnType<typeof z.json>>;
export type ImportCursor = Record<string, JsonValue>;
export type ImportPage = { records: ImportRecord[]; cursor: ImportCursor | null };
export type ProposedMapping = {
  kind: 'status' | 'priority' | 'group' | 'agent' | 'field' | 'tag' | 'channel';
  externalValue: string;
  target: Record<string, JsonValue>;
};
export type ConnectorContext<Credentials> = {
  credentials: Credentials;
  http: ImportHttp;
  signal: AbortSignal;
  log: (entry: {
    level: 'info' | 'warning' | 'error';
    message: string;
    entity?: ImportEntity;
    externalId?: string;
  }) => Promise<void>;
};
export interface Connector<Credentials> {
  readonly source: Exclude<ImportSource, 'file'>;
  readonly credentialsSchema: z.ZodType<Credentials>;
  readonly entities: readonly ImportEntity[];
  test(
    context: ConnectorContext<Credentials>,
  ): Promise<
    | { ok: true; account: string }
    | { ok: false; reason: 'credentials-refused' | 'vendor-unavailable' | 'invalid-response' }
  >;
  extract(
    context: ConnectorContext<Credentials>,
    entity: ImportEntity,
    cursor: ImportCursor | null,
    since?: Date,
  ): AsyncIterable<ImportPage>;
  fetchAttachment(
    context: ConnectorContext<Credentials>,
    ref: ImportAttachmentRef,
  ): Promise<{ stream: Readable; contentType?: string; size?: number }>;
  defaultMappings(sample: readonly ImportRecord[]): ProposedMapping[];
}
