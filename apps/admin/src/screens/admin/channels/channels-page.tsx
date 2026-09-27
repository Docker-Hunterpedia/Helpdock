import { Box, Button, Tab, Tabs } from '@mui/material';
import { Construction, Mail, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { channelsRoute, ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { MailboxesTab } from './mailboxes-tab.tsx';
import {
  CHANNELS_TABS,
  type ChannelsTab,
  channelsTabForSegment,
  DEFAULT_CHANNELS_TAB,
} from './tabs.js';

/**
 * `Admin/Channels` (M2-08, the `Admin · email channel` artboard): the header
 * with "Add mailbox", the tab row, and the tab the url names. The tabs are
 * links, as on Ticketing, so a tab is a url and back works.
 */
export function ChannelsPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const { tab: segment } = useParams();

  const tab = channelsTabForSegment(segment);
  if (tab === undefined) {
    return <Navigate to={channelsRoute(DEFAULT_CHANNELS_TAB.segment)} replace />;
  }

  return (
    <>
      <PageHeader
        title={t('channels:title')}
        caption={t('channels:subtitle', { brand: brand.name })}
        action={
          <Button
            variant="contained"
            component={Link}
            to={ROUTES.mailboxNew}
            startIcon={<Plus size={16} aria-hidden="true" />}
          >
            {t('channels:addMailbox')}
          </Button>
        }
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('channels:tabList')}>
          {CHANNELS_TABS.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              icon={<Mail size={14} aria-hidden="true" />}
              iconPosition="start"
              label={t(`channels:tabs.${candidate.key}`)}
              component={Link}
              to={channelsRoute(candidate.segment)}
            />
          ))}
        </Tabs>
      </Box>

      <TabBody tab={tab} />
    </>
  );
}

function TabBody({ tab }: { readonly tab: ChannelsTab }): ReactNode {
  const t = useT();

  switch (tab.key) {
    case 'mailboxes':
      return <MailboxesTab />;
    default:
      return (
        <EmptyState
          icon={Construction}
          heading={t('channels:soon.heading')}
          body={t('channels:soon.body', {
            tab: t(`channels:tabs.${tab.key}`),
            milestone: tab.milestone,
          })}
        />
      );
  }
}
