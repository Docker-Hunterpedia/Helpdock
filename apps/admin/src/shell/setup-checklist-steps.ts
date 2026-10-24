import type { SetupChecklistStepId } from '@helpdock/schemas';
import { automationRoute, ROUTES, ticketingRoute } from '../app/route-paths.js';
import { AUTOMATION_TABS } from '../screens/admin/automation/tabs.js';
import { TICKETING_TABS, type TicketingTabKey } from '../screens/admin/ticketing/tabs.js';

const ticketingTab = (key: TicketingTabKey): string =>
  ticketingRoute(TICKETING_TABS.find((tab) => tab.key === key)?.segment ?? key);

const automationMacros = (): string =>
  automationRoute(AUTOMATION_TABS.find((tab) => tab.key === 'macros')?.segment ?? 'macros');

/**
 * Where each step is done. Built from the route constants and the tabs' own
 * segments, so a page that moves (the settings area shell, M14-21) takes its
 * checklist link with it. The AI step goes to the page itself: which tab a
 * brand Admin may open depends on whether they also administer the install.
 */
export const setupStepRoute = (step: SetupChecklistStepId): string =>
  ({
    channel: ROUTES.channels,
    teammate: ROUTES.staff,
    businessHours: ticketingTab('businessHours'),
    slaPolicy: ticketingTab('slas'),
    assignment: ticketingTab('assignment'),
    reply: automationMacros(),
    article: ROUTES.helpCenter,
    aiProvider: ROUTES.ai,
    firstTicket: ROUTES.tickets,
  })[step];
