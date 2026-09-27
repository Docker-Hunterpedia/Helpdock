import { Box, Tab, Tabs } from '@mui/material';
import { Mail } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { SecurityScreen } from '../security.tsx';
import { NotificationsTab } from './notifications-tab.tsx';

/**
 * Your account (`/me`, artboards `AdminNotifications` panel 2 and
 * `AdminSignature`): one page header, three tabs, and the tab's own content.
 *
 * Security is the M0-06 page, moved under the shell unchanged. Notifications is
 * M3-07's. Email signature belongs to M2's outbound email; the tab and its route
 * exist so that deliverable only has to replace {@link SignatureTab}.
 */

const ACCOUNT_TABS = [
  { key: 'security', path: ROUTES.security },
  { key: 'notifications', path: ROUTES.meNotifications },
  { key: 'signature', path: ROUTES.meSignature },
] as const;

type AccountTab = (typeof ACCOUNT_TABS)[number]['key'];

export function YourAccountPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { tab: segment } = useParams();

  const tab = ACCOUNT_TABS.find((candidate) => candidate.key === segment);
  if (tab === undefined) {
    return <Navigate to={ROUTES.security} replace />;
  }

  return (
    <>
      <PageHeader title={t('me:account.title')} caption={t('me:account.caption')} />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('me:account.tabList')}>
          {ACCOUNT_TABS.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`me:account.tabs.${candidate.key}`)}
              component={Link}
              to={candidate.path}
            />
          ))}
        </Tabs>
      </Box>

      <AccountTabContent tab={tab.key} />
    </>
  );
}

function AccountTabContent({ tab }: { readonly tab: AccountTab }): ReactNode {
  switch (tab) {
    case 'security':
      return <SecurityScreen />;
    case 'notifications':
      return <NotificationsTab />;
    case 'signature':
      return <SignatureTab />;
  }
}

/** The route stub M2's outbound email replaces with the signature form (`AdminSignature`). */
function SignatureTab(): ReactNode {
  const t = useT();

  return (
    <EmptyState
      icon={Mail}
      heading={t('me:account.tabs.signature')}
      body={t('me:account.signaturePending')}
    />
  );
}
