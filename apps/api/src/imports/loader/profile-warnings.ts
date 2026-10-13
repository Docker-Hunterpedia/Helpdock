import { type DbTransaction, importLog } from '@helpdock/db';
import type { ImportRunScope } from './run-scope.js';
export async function profileWarning(
  tx: DbTransaction,
  options: ImportRunScope & {
    entity: 'contact' | 'organization';
    externalId: string;
    message:
      | 'import.phone.invalid'
      | 'import.locale.unsupported'
      | 'import.timezone.invalid'
      | 'import.identity.reused'
      | 'import.organization.reused';
  },
): Promise<void> {
  await tx.insert(importLog).values({
    brandId: options.brandId,
    runId: options.runId,
    entity: options.entity,
    externalId: options.externalId,
    level: 'warning',
    message: options.message,
  });
}
