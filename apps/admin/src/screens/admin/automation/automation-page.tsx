import { Box, Tab, Tabs } from '@mui/material';
import { Construction } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { automationRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { MacrosTab } from './macros-tab.tsx';
import { type AutomationTab, tabForSegment, tabsFor } from './tabs.js';

/**
 * `Admin/Automation`: the page header, the tab row, and whichever tab the url
 * names (artboards `AdminAutomationRules`, `AdminAutomationMacros`).
 *
 * M3-06 ships the Macros tab. Rules and Time-based are M3-05's and M3-04's,
 * and draw the "not built yet" state until those land, as `Admin/Ticketing`
 * did through M1. The tabs are links, so a tab is a url.
 */
export function AutomationPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();

  const tabs = tabsFor(session.user.role);
  const tab = tabForSegment(tabs, segment);
  const first = tabs[0];
  if (tab === undefined) {
    return first === undefined ? null : <Navigate to={automationRoute(first.segment)} replace />;
  }

  return (
    <>
      <PageHeader
        title={t('macros:shell.title')}
        caption={t('macros:shell.subtitle', { brand: brand.name })}
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('macros:shell.tabList')}>
          {tabs.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`macros:shell.tabs.${candidate.key}`)}
              component={Link}
              to={automationRoute(candidate.segment)}
            />
          ))}
        </Tabs>
      </Box>

      <TabBody tab={tab} />
    </>
  );
}

function TabBody({ tab }: { readonly tab: AutomationTab }): ReactNode {
  const t = useT();

  if (tab.key === 'macros') {
    return <MacrosTab />;
  }

  return (
    <EmptyState
      icon={Construction}
      heading={t('macros:shell.soon.heading')}
      body={t('macros:shell.soon.body', {
        tab: t(`macros:shell.tabs.${tab.key}`),
        milestone: tab.milestone,
      })}
    />
  );
}
