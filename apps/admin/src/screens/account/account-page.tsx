import { Box, Tab, Tabs } from '@mui/material';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { PageHeader } from '../../shell/page-header.tsx';
import { SecurityScreen } from '../security.tsx';
import { NotificationsTab } from './notifications-tab.tsx';
import { ProfileTab } from './profile-tab.tsx';
import { SignatureTab } from './signature-page.tsx';

/**
 * Your account (`/me`, artboards `Admin/Account-Profile`, `AdminNotifications`
 * panel 2 and `AdminSignature`): one page header, four tabs, and the tab's own content.
 *
 * Profile is M14-12's, first because it is how the person appears to customers.
 * Security is the M0-06 page, moved under the shell unchanged. Notifications is
 * M3-07's, and Email signature is M2-05's. The tab row is a list of links, so
 * each tab is a url of its own.
 */

export const ACCOUNT_TABS = [
  { key: 'profile', path: ROUTES.meProfile },
  { key: 'security', path: ROUTES.security },
  { key: 'notifications', path: ROUTES.meNotifications },
  { key: 'signature', path: ROUTES.signature },
] as const;

type AccountTab = (typeof ACCOUNT_TABS)[number]['key'];

export function YourAccountPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { tab: segment } = useParams();

  const tab = ACCOUNT_TABS.find((candidate) => candidate.key === segment);
  if (tab === undefined) {
    return <Navigate to={ROUTES.meProfile} replace />;
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
    case 'profile':
      return <ProfileTab />;
    case 'security':
      return <SecurityScreen />;
    case 'notifications':
      return <NotificationsTab />;
    case 'signature':
      return <SignatureTab />;
  }
}
