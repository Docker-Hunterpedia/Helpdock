import { Box, Tab, Tabs } from '@mui/material';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ticketingRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AssignmentTab } from './assignment-tab.tsx';
import { CustomFieldsTab } from './custom-fields-tab.tsx';
import { DepartmentsTab } from './departments-tab.tsx';
import { FeedbackTab } from './feedback-tab.tsx';
import { NotBuiltYetTab } from './not-built-yet-tab.tsx';
import { SpamTab } from './spam-tab.tsx';
import { StatusesTab } from './statuses-tab.tsx';
import { DEFAULT_TICKETING_TAB, TICKETING_TABS, type TicketingTab, tabForSegment } from './tabs.js';
import { TagsTab } from './tags-tab.tsx';
import { TemplatesTab } from './templates-tab.tsx';

/**
 * `Admin/Ticketing`: the page header, the tab row, and whichever tab the url
 * names. Eight of the ten are built — Departments (M1-01), Statuses (M1-08),
 * Tags, Custom fields and Templates (M1-06), Assignment (M1-07), Spam (M1-11)
 * and Feedback (M1-12); the rest are the routed
 * placeholders their deliverables replace, which is why the row is whole from
 * the start.
 *
 * The tabs are links rather than state, so a tab is a url somebody can send to
 * a colleague, the browser's back button works, and a reload lands where it
 * left off.
 */
export function TicketingPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
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
        caption={t('ticketing:subtitle', { brand: brand.name })}
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs
          value={tab.key}
          variant="scrollable"
          scrollButtons="auto"
          aria-label={t('ticketing:tabList')}
        >
          {TICKETING_TABS.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`ticketing:tabs.${candidate.key}`)}
              component={Link}
              to={ticketingRoute(candidate.segment)}
            />
          ))}
        </Tabs>
      </Box>

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
    case 'tags':
      return <TagsTab />;
    case 'customFields':
      return <CustomFieldsTab />;
    case 'templates':
      return <TemplatesTab />;
    case 'spam':
      return <SpamTab />;
    case 'assignment':
      return <AssignmentTab />;
    case 'feedback':
      return <FeedbackTab />;
    default:
      return <NotBuiltYetTab tab={tab} />;
  }
}
