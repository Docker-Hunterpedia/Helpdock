import { Box, Tab, Tabs } from '@mui/material';
import { Database } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { aiRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AssistantTab } from './assistant/assistant-tab.tsx';
import { ProvidersTab } from './providers/providers-tab.tsx';
import { type AiTab, aiTabForSegment, aiTabsFor } from './tabs.js';

/**
 * `Admin/AI` (M7-10; artboards `Admin/AI-Providers` and `Admin/AI-Assistant`):
 * the page header, the tabs the viewer may open, and the tab the url names.
 * The tabs are links, as on Channels, so a tab is a url and back works.
 * Knowledge is drawn as "arrives with M7-03" until its api lands.
 */
export function AiPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();
  const tabs = aiTabsFor(session.user);

  const tab = aiTabForSegment(segment, session.user);
  const landing = tabs[0];
  if (tab === undefined) {
    return landing === undefined ? null : <Navigate to={aiRoute(landing.segment)} replace />;
  }

  return (
    <>
      <PageHeader
        title={t('aiSettings:title')}
        caption={
          tab.key === 'providers'
            ? t('aiSettings:subtitle.install')
            : t('aiSettings:subtitle.brand', { brand: brand.name })
        }
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('aiSettings:tabList')}>
          {tabs.map(({ key, segment: path, icon: Icon }) => (
            <Tab
              key={key}
              value={key}
              icon={<Icon size={14} aria-hidden="true" />}
              iconPosition="start"
              label={t(`aiSettings:tabs.${key}`)}
              component={Link}
              to={aiRoute(path)}
              sx={{ minHeight: 40 }}
            />
          ))}
        </Tabs>
      </Box>

      <TabBody tab={tab} brandId={brand.id} />
    </>
  );
}

function TabBody({ tab, brandId }: { readonly tab: AiTab; readonly brandId: string }): ReactNode {
  const t = useT();

  switch (tab.key) {
    case 'providers':
      return <ProvidersTab />;
    case 'knowledge':
      return (
        <EmptyState
          icon={Database}
          heading={t('admin:pages.empty.heading')}
          body={t('aiSettings:knowledge.placeholder')}
        />
      );
    case 'assistant':
      return <AssistantTab brandId={brandId} />;
  }
}
