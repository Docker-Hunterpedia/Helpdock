import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useSession } from '../../../auth/session.tsx';
import { firstSettingsPath } from '../../../shell/settings-nav.js';
import { AutomationPage } from '../automation/automation-page.tsx';
import { AUTOMATION_TABS } from '../automation/tabs.js';
import { TICKETING_TABS } from '../ticketing/tabs.js';
import { TicketingPage } from '../ticketing/ticketing-page.tsx';

/**
 * The Inbox group of the Settings area (M14-21): the twelve ticketing settings
 * and Automation's Rules, Time-based, Routing and Macros share one url prefix,
 * and the segment says which page draws it. A segment that is neither goes to
 * the first page the reader is offered, as each page's own landing did.
 */
export function InboxPage(): ReactNode {
  const { tab: segment } = useParams();
  const session = useSession();

  if (TICKETING_TABS.some((tab) => tab.segment === segment)) {
    return <TicketingPage />;
  }
  if (AUTOMATION_TABS.some((tab) => tab.segment === segment)) {
    return <AutomationPage />;
  }

  return <Navigate to={firstSettingsPath(session.user, 'inbox')} replace />;
}
