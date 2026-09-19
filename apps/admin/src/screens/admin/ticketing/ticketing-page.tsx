import { Box, Tab, Tabs } from '@mui/material';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ticketingRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { DepartmentsTab } from './departments-tab.tsx';
import { NotBuiltYetTab } from './not-built-yet-tab.tsx';
import { DEFAULT_TICKETING_TAB, TICKETING_TABS, tabForSegment } from './tabs.js';

/**
 * `Admin/Ticketing`: the page header, the tab row, and whichever tab the url
 * names. Only the first tab is built — the rest are the routed placeholders
 * their M1 deliverables replace, which is why the row is whole from the start.
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

      {tab.key === 'departments' ? <DepartmentsTab /> : <NotBuiltYetTab tab={tab} />}
    </>
  );
}
