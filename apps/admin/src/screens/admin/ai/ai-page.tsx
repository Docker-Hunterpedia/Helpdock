import { Box, Button, Tab, Tabs } from '@mui/material';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { aiRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AssistantTab } from './assistant/assistant-tab.tsx';
import { KnowledgeTab } from './knowledge/knowledge-tab.tsx';
import { ProvidersTab } from './providers/providers-tab.tsx';
import { aiTabForSegment, aiTabsFor } from './tabs.js';

/**
 * `Admin/AI` (M7-10; artboards `Admin/AI-Providers`, `Admin/AI-Knowledge` and
 * `Admin/AI-Assistant`): the page header, the tabs the viewer may open, and
 * the tab the url names. The tabs are links, as on Channels, so a tab is a url
 * and back works. "Add source" belongs to the Knowledge tab alone.
 */
export function AiPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();
  const [adding, setAdding] = useState(false);
  const tabs = aiTabsFor(session.user);

  const tab = aiTabForSegment(segment, session.user);
  const landing = tabs[0];
  if (tab === undefined) {
    return landing === undefined ? null : <Navigate to={aiRoute(landing.segment)} replace />;
  }

  const caption = {
    providers: t('aiSettings:subtitle.install'),
    knowledge: t('aiSettings:knowledge.subtitle', { brand: brand.name }),
    assistant: t('aiSettings:subtitle.brand', { brand: brand.name }),
  }[tab.key];

  return (
    <>
      <PageHeader
        title={t('aiSettings:title')}
        caption={caption}
        action={
          tab.key === 'knowledge' ? (
            <Button
              variant="contained"
              startIcon={<Plus size={16} aria-hidden="true" />}
              onClick={() => {
                setAdding(true);
              }}
            >
              {t('aiSettings:knowledge.add')}
            </Button>
          ) : undefined
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

      {tab.key === 'providers' ? <ProvidersTab /> : null}
      {tab.key === 'knowledge' ? (
        <KnowledgeTab
          brandId={brand.id}
          brandName={brand.name}
          adding={adding}
          onAddingChange={setAdding}
        />
      ) : null}
      {tab.key === 'assistant' ? <AssistantTab brandId={brand.id} /> : null}
    </>
  );
}
