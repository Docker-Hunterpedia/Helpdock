import { Box, Tab, Tabs } from '@mui/material';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ROUTES } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The tab row of Your account (`/me`, artboard `AdminSignature`): Security
 * and Email signature. The artboard also draws Notifications, which is M3's
 * notifications work and joins this row when it lands; the row is a list of
 * links, so each tab is a url of its own.
 */

const ACCOUNT_TABS = [
  { key: 'security', path: ROUTES.security },
  { key: 'signature', path: ROUTES.signature },
] as const;

export type AccountTab = (typeof ACCOUNT_TABS)[number]['key'];

export function AccountTabs({ current }: { readonly current: AccountTab }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
      <Tabs value={current} aria-label={t('me:tabs.label')}>
        {ACCOUNT_TABS.map((tab) => (
          <Tab
            key={tab.key}
            value={tab.key}
            label={t(`me:tabs.${tab.key}`)}
            component={Link}
            to={tab.path}
          />
        ))}
      </Tabs>
    </Box>
  );
}
