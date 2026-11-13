import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ticketingRoute } from '../../../app/route-paths.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AssignmentTab } from './assignment-tab.tsx';
import { BusinessHoursTab } from './business-hours-tab.tsx';
import { CustomFieldsTab } from './custom-fields-tab.tsx';
import { DepartmentsTab } from './departments-tab.tsx';
import { FeedbackTab } from './feedback-tab.tsx';
import { PrioritiesTab } from './priorities-tab.tsx';
import { SlasTab } from './slas-tab.tsx';
import { SpamTab } from './spam-tab.tsx';
import { StatusesTab } from './statuses-tab.tsx';
import { DEFAULT_TICKETING_TAB, type TicketingTab, tabForSegment } from './tabs.js';
import { TagsTab } from './tags-tab.tsx';
import { TemplatesTab } from './templates-tab.tsx';
import { ViewsTab } from './views-tab.tsx';

/**
 * `Admin/Ticketing`: the page header and whichever setting the url names. Since
 * M14-21 each page is a link of the Settings area's Inbox group
 * (`/settings/inbox/<segment>`), so a setting is a url somebody can send to a
 * colleague, the browser's back button works, and a reload lands where it left
 * off. An address that names no page here opens Departments.
 */
export function TicketingPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();

  const tab = tabForSegment(segment);
  if (tab === undefined) {
    return <Navigate to={ticketingRoute(DEFAULT_TICKETING_TAB.segment)} replace />;
  }

  return (
    <>
      <PageHeader
        title={t('ticketing:title')}
        // Priorities carries its own introduction, as drawn.
        caption={
          tab.key === 'priorities' ? undefined : t('ticketing:subtitle', { brand: brand.name })
        }
      />

      <TabBody tab={tab} />
    </>
  );
}

/**
 * Which tab's body to draw. A function rather than a nested ternary, so adding
 * the next built tab is a case and not another level of nesting.
 */
function TabBody({ tab }: { readonly tab: TicketingTab }): ReactNode {
  switch (tab.key) {
    case 'departments':
      return <DepartmentsTab />;
    case 'statuses':
      return <StatusesTab />;
    case 'priorities':
      return <PrioritiesTab />;
    case 'tags':
      return <TagsTab />;
    case 'customFields':
      return <CustomFieldsTab />;
    case 'templates':
      return <TemplatesTab />;
    case 'views':
      return <ViewsTab />;
    case 'spam':
      return <SpamTab />;
    case 'assignment':
      return <AssignmentTab />;
    case 'feedback':
      return <FeedbackTab />;
    case 'businessHours':
      return <BusinessHoursTab />;
    case 'slas':
      return <SlasTab />;
  }
}
