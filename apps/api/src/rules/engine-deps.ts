import type { JobLogger } from '@helpdock/jobs';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { BusinessHoursService } from '../sla/business-hours.service.js';
import { businessHoursProbe } from '../sla/business-hours-probe.js';
import { SlaRepository } from '../sla/sla.repository.js';
import { SlaService } from '../sla/sla.service.js';
import { SlaLifecycleHooks } from '../sla/sla-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import type { RulesEngineDeps } from './engine.js';
import { type CannedResponseRenderer, noCannedResponses } from './ports.js';
import { RulesRepository } from './rules.repository.js';

/**
 * What the rules engine acts with, built outside Nest because the worker runs
 * no Nest application. Every repository is stateless.
 *
 * The lifecycle is M1's own service with the hooks `TicketsModule` gives it —
 * M3-02's SLA hooks, which extend M1-12's survey — so a rule that closes a
 * ticket schedules the survey an agent's close would, and a rule's change or
 * canned reply moves the clocks as an agent's would.
 *
 * The "business hours" condition reads M3-01's calendar. `cannedResponses` is
 * the seam `ports.ts` describes; until M3-06 is wired, a canned reply is
 * recorded as unavailable.
 */
export const createRulesEngineDeps = ({
  log,
  cannedResponses = noCannedResponses,
}: {
  readonly log: JobLogger;
  readonly cannedResponses?: CannedResponseRenderer;
}): RulesEngineDeps => {
  const tickets = new TicketRepository();
  const lifecycleReads = new TicketLifecycleRepository();
  const slaRepository = new SlaRepository();
  const sla = new SlaService(slaRepository);

  return {
    rules: new RulesRepository(),
    tickets,
    assignment: new AssignmentRepository(),
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new SlaLifecycleHooks(lifecycleReads, sla),
    ),
    cannedResponses,
    businessHours: businessHoursProbe(new BusinessHoursService(slaRepository, sla)),
    log,
  };
};
