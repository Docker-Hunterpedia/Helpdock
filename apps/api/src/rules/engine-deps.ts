import type { JobLogger } from '@helpdock/jobs';
import { AssignmentRepository } from '../assignment/assignment.repository.js';
import { CsatLifecycleHooks } from '../csat/csat-hooks.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { TicketLifecycleService } from '../tickets/lifecycle/lifecycle.service.js';
import { TicketRepository } from '../tickets/tickets.repository.js';
import type { RulesEngineDeps } from './engine.js';
import {
  alwaysOpen,
  type BusinessHoursProbe,
  type CannedResponseRenderer,
  noCannedResponses,
} from './ports.js';
import { RulesRepository } from './rules.repository.js';

/**
 * What the rules engine acts with, built outside Nest because the worker runs
 * no Nest application. Every repository is stateless.
 *
 * The lifecycle is M1's own service with the hooks `TicketsModule` gives it
 * (M1-12's survey), so a rule that closes a ticket schedules the survey an
 * agent's close would. M3-02's clocks replace those hooks there, and here.
 *
 * `cannedResponses` and `businessHours` are the two seams `ports.ts`
 * describes; until M3-06 and M3-01 are wired, a canned reply is recorded as
 * unavailable and every department is open.
 */
export const createRulesEngineDeps = ({
  log,
  cannedResponses = noCannedResponses,
  businessHours = alwaysOpen,
}: {
  readonly log: JobLogger;
  readonly cannedResponses?: CannedResponseRenderer;
  readonly businessHours?: BusinessHoursProbe;
}): RulesEngineDeps => {
  const tickets = new TicketRepository();
  const lifecycleReads = new TicketLifecycleRepository();

  return {
    rules: new RulesRepository(),
    tickets,
    assignment: new AssignmentRepository(),
    lifecycle: new TicketLifecycleService(
      lifecycleReads,
      tickets,
      new CsatLifecycleHooks(lifecycleReads),
    ),
    cannedResponses,
    businessHours,
    log,
  };
};
