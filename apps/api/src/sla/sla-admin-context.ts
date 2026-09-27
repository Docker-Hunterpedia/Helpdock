import { getTx, requireRequestContext } from '../context/request-context.js';
import { activityActorFor } from '../tickets/ticket-activity.js';
import type { SlaAdminContext } from './business-hours.service.js';

/**
 * The actor behind a Business hours or SLAs route, built from the principal
 * the guard resolved — for the reason `DepartmentsController` gives: the
 * claims are what the permission was checked against, and a second source
 * would be a second answer to "who is asking?".
 *
 * Staff only. The scope rules are about which departments a person leads,
 * and an api key leads none; M8 decides separately what a key may configure.
 */
export const slaAdminContext = (): SlaAdminContext => {
  const request = requireRequestContext();
  const principal = request.principal;
  const brandId = request.targetBrandId;

  const membership =
    principal?.type === 'staff' && brandId !== null ? principal.brands[brandId] : undefined;
  /* c8 ignore next 3 -- the permission guard has already refused anything else. */
  if (principal?.type !== 'staff' || brandId === null || membership === undefined) {
    throw new Error('An SLA settings route ran without a staff member of its target brand');
  }

  return {
    tx: getTx(),
    brandId,
    actor: {
      userId: principal.id,
      role: membership.role,
      departmentIds: membership.departmentIds,
    },
    auditActor: activityActorFor(principal),
    now: new Date(),
  };
};
