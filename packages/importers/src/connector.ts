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
export type ImportPage = {
  records: ImportRecord[];
  cursor: ImportCursor | null;
  /** Final vendor watermark for the next delta; distinct from the current run's continuation. */
  deltaCursor?: ImportCursor;
};
export type ProposedMapping = {
  kind: 'status' | 'priority' | 'group' | 'agent' | 'field' | 'tag' | 'channel';
  externalValue: string;
  target: Record<string, JsonValue>;
};

/**
 * The target of a priority or channel mapping, with the key written out. A
 * computed `{ [kind]: value }` would let the kind, which arrives in a request,
 * name the property; Zod and the type narrow it to these two, and spelling
 * them keeps that true whatever reaches here.
 */
export const valueMappingTarget = (
  kind: 'priority' | 'channel',
  value: string,
): Record<string, JsonValue> => (kind === 'priority' ? { priority: value } : { channel: value });

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
  readonly source: ImportSource;
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
