import type { ImportRecord } from '@helpdock/schemas';
import type { Connector, ConnectorContext, ImportCursor } from '../connector.js';

/** Restart each entity's iterator after its first committed data page, preserving only JSON state. */
export async function collectReference<C>(
  connect: () => { connector: Connector<C>; context: ConnectorContext<C> },
  since?: Date,
): Promise<ImportRecord[]> {
  const records = new Map<string, ImportRecord>();
  for (const entity of connect().connector.entities) {
    let cursor: ImportCursor | null = null;
    let restarted = false;
    do {
      const { connector, context } = connect();
      for await (const page of connector.extract(context, entity, cursor, since)) {
        for (const record of page.records) {
          if (record.entity !== entity)
            throw new Error('Reference export returned the wrong entity');
          records.set(`${entity}:${record.payload.externalId}`, record);
        }
        cursor = page.cursor === null ? null : JSON.parse(JSON.stringify(page.cursor));
        if (!restarted && cursor !== null && page.records.length) {
          restarted = true;
          break;
        }
      }
    } while (cursor !== null);
  }
  return [...records.values()];
}
