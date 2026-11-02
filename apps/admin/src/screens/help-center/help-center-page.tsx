import { Box, Button } from '@mui/material';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { helpCenterRoute } from '../../app/route-paths.js';
import { currentBrand, useSession } from '../../auth/session.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { ArticlesTab } from './articles-tab.tsx';
import { InsightsTab } from './insights-tab.tsx';
import { NewArticleButton } from './new-article-button.tsx';
import { ProposalsTab } from './proposals-tab.tsx';
import { SettingsTab } from './settings-tab.tsx';
import { openHelpCenterHref } from './site/site-draft.js';
import { helpCenterTabsFor, managesHelpCenter } from './tabs.js';

export { type HelpCenterTab, helpCenterTabsFor, managesHelpCenter } from './tabs.js';

/**
 * `Admin/HelpCenter` (M5-01, M5-09): the page header with "View help
 * center" (M5-03) and the page the url names. The pages are entries of the
 * sidebar's Help center section (`Admin/UX-Fixes-2026-11`), not a tab row. Settings holds "Who can
 * read it" (M5-09) and the Theme, Home page, Links and Custom CSS cards
 * (M5-06). Insights is M5-08's (`insights-tab.tsx`); Proposals, the articles
 * agents drafted from tickets, M7-05's (`proposals-tab.tsx`).
 *
 * An Agent sees Articles alone (the artboard's footnote); a Viewer sees every
 * tab read-only; changing anything is an Admin's or a Team Leader's.
 */

export function HelpCenterPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();
  const tabs = helpCenterTabsFor(session.user.role);
  const tab = tabs.find((candidate) => candidate.key === segment);
  if (tab === undefined) {
    return <Navigate to={helpCenterRoute('articles')} replace />;
  }

  const canManage = managesHelpCenter(session.user.role);

  return (
    <>
      <PageHeader
        title={t('helpCenter:title')}
        caption={`${brand.name} · ${brand.domain}`}
        action={
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button
              variant="outlined"
              href={openHelpCenterHref(brand.id, {})}
              target="_blank"
              rel="noopener"
              startIcon={<ExternalLink size={16} aria-hidden="true" />}
            >
              {t('helpCenter:viewHelpCenter')}
            </Button>
            {tab.key === 'articles' && canManage ? <NewArticleButton /> : null}
          </Box>
        }
      />

      {tab.key === 'articles' ? (
        <ArticlesTab canManage={canManage} />
      ) : tab.key === 'proposals' ? (
        <ProposalsTab />
      ) : tab.key === 'settings' ? (
        <SettingsTab canManage={canManage} />
      ) : (
        <InsightsTab canManage={canManage} />
      )}
    </>
  );
}
