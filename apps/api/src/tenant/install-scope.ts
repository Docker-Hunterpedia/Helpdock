import { auditLog, type DbTransaction, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import type { Principal } from '../auth/principal.js';
import { principalIdOf } from '../auth/principal.js';
import type { RequestContext } from '../context/request-context.js';

/** The audit action every install-scope entry is recorded under. */
export const INSTALL_SCOPE_ACTION = 'install.scope.access';

/**
 * "Install-admin 'all brands' paths set the full list explicitly and are
 * audited" (ARCHITECTURE §6). The row is written inside the request's own
 * transaction, before the handler runs: if the handler fails and the
 * transaction rolls back, the access did not happen either.
 */
export const auditInstallScopeAccess = async (
  tx: DbTransaction,
  context: RequestContext,
  principal: Principal,
): Promise<void> => {
  await tx.insert(auditLog).values({
    brandId: INSTALL_SCOPE_BRAND_ID,
    actorType: principal.type,
    actorId: principalIdOf(principal),
    action: INSTALL_SCOPE_ACTION,
    targetType: 'route',
    targetId: `${context.method} ${context.path}`,
    meta: { requestId: context.requestId },
  });
};
