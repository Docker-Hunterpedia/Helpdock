import { isWithinBusinessHours } from '@helpdock/schemas';
import type { BusinessHoursProbe } from '../email/auto-reply.service.js';
import type { BusinessHoursService } from './business-hours.service.js';

/**
 * M2-06's "is this department open now?", answered by M3-01's calendar: the
 * department's own hours and holidays if it has them, otherwise the brand's.
 * The worker passes its own transaction, so the read runs under the event's
 * tenant context.
 */
export const businessHoursProbe = (
  businessHours: Pick<BusinessHoursService, 'calendarFor'>,
): BusinessHoursProbe => ({
  isOpen: async (tx, { brandId, departmentId, at }) =>
    isWithinBusinessHours(await businessHours.calendarFor(brandId, departmentId, tx), at),
});
