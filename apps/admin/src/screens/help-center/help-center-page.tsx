import type { StaffRole } from '@helpdock/schemas';
import { Box, Button, Tab, Tabs } from '@mui/material';
import { BarChart3, ExternalLink, FileText, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { helpCenterRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession } from '../../auth/session.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { ArticlesTab } from './articles-tab.tsx';
import { InsightsTab } from './insights-tab.tsx';
import { NewArticleButton } from './new-article-button.tsx';
import { SettingsTab } from './settings-tab.tsx';
import { openHelpCenterHref } from './site/site-draft.js';

/**
 * `Admin/HelpCenter` (M5-01, M5-09): the page header with "View help
 * center" (M5-03), the tab row, and the Articles tab. Settings holds "Who can
 * read it" (M5-09) and the Theme, Home page, Links and Custom CSS cards
 * (M5-06). Insights is M5-08's (`insights-tab.tsx`).
 *
 * An Agent sees Articles alone (the artboard's footnote); a Viewer sees every
 * tab read-only; changing anything is an Admin's or a Team Leader's.
 */

const TABS = [
  { key: 'articles', icon: FileText, roles: ['admin', 'teamLeader', 'agent', 'viewer'] },
  { key: 'settings', icon: Settings, roles: ['admin', 'teamLeader', 'viewer'] },
  { key: 'insights', icon: BarChart3, roles: ['admin', 'teamLeader', 'viewer'] },
] as const satisfies readonly { key: string; icon: unknown; roles: readonly StaffRole[] }[];

export type HelpCenterTab = (typeof TABS)[number]['key'];

export const helpCenterTabsFor = (role: StaffRole) =>
  TABS.filter((tab) => (tab.roles as readonly StaffRole[]).includes(role));

/** Whether this role may change the help center (DOMAIN-RULES §1.2). */
export const managesHelpCenter = (role: StaffRole): boolean =>
  role === 'admin' || role === 'teamLeader';

export function HelpCenterPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
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

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('helpCenter:tabs.label')}>
          {tabs.map((candidate) => {
            const Icon = candidate.icon;
            return (
              <Tab
                key={candidate.key}
                value={candidate.key}
                icon={<Icon size={16} aria-hidden="true" />}
                iconPosition="start"
                label={t(`helpCenter:tabs.${candidate.key}`)}
                component={Link}
                to={helpCenterRoute(candidate.key)}
              />
            );
          })}
        </Tabs>
      </Box>

      {tab.key === 'articles' ? (
        <ArticlesTab canManage={canManage} />
      ) : tab.key === 'settings' ? (
        <SettingsTab canManage={canManage} />
      ) : (
        <InsightsTab canManage={canManage} />
      )}
    </>
  );
}
