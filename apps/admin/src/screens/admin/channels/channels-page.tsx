import type { EmailOutgoingSettings } from '@helpdock/schemas';
import { Box, Tab, Tabs, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { channelsRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useEmailApi, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { emailKeys } from '../../../email/api.js';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { AutoRepliesCard } from './auto-replies-card.tsx';
import { FailedSendsCard } from './failed-sends-card.tsx';
import { SendersCard } from './senders-card.tsx';
import { SmtpCard } from './smtp-card.tsx';

/**
 * `Admin/Channels` (artboards `AdminEmail`, `AdminEmailOutgoing`): the page
 * header and the Mailboxes / Outgoing email tab row.
 *
 * This branch builds **Outgoing email** (M2-05, M2-06, M2-08's outbound half).
 * Mailboxes is inbound mail's (M2-02, M2-03, M2-08's inbound half) and is a
 * placeholder here until that work lands on the same page.
 */

export const CHANNEL_TABS = [
  { key: 'mailboxes', segment: 'mailboxes', icon: Inbox },
  { key: 'outgoing', segment: 'outgoing', icon: Send },
] as const;

type ChannelTab = (typeof CHANNEL_TABS)[number];

export function ChannelsPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();

  const tab = CHANNEL_TABS.find((candidate) => candidate.segment === segment);
  if (tab === undefined) {
    return <Navigate to={channelsRoute('outgoing')} replace />;
  }

  return (
    <>
      <PageHeader
        title={t('channels:title')}
        caption={t('channels:subtitle', { brand: brand.name })}
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('channels:tabList')}>
          {CHANNEL_TABS.map(({ key, segment: path, icon: Icon }) => (
            <Tab
              key={key}
              value={key}
              icon={<Icon size={14} aria-hidden="true" />}
              iconPosition="start"
              label={t(`channels:tabs.${key}`)}
              component={Link}
              to={channelsRoute(path)}
              sx={{ minHeight: 40 }}
            />
          ))}
        </Tabs>
      </Box>

      <TabBody tab={tab} brandId={brand.id} />
    </>
  );
}

function TabBody({
  tab,
  brandId,
}: {
  readonly tab: ChannelTab;
  readonly brandId: string;
}): ReactNode {
  const t = useT();

  if (tab.key === 'outgoing') {
    return <OutgoingTab brandId={brandId} />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxWidth: 640 }}>
      <Typography variant="h3" component="h2">
        {t('channels:mailboxes.heading')}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {t('channels:mailboxes.body')}
      </Typography>
    </Box>
  );
}

function OutgoingTab({ brandId }: { readonly brandId: string }): ReactNode {
  const t = useT();
  const api = useEmailApi();
  const ticketing = useTicketingApi();
  const queryClient = useQueryClient();

  const outgoing = useQuery({
    queryKey: emailKeys.outgoing(brandId),
    queryFn: () => api.outgoing(brandId),
  });
  const departments = useQuery({
    queryKey: ['departments', brandId],
    queryFn: () => ticketing.departments(brandId),
  });

  const saved = (settings: EmailOutgoingSettings): void => {
    queryClient.setQueryData(emailKeys.outgoing(brandId), settings);
  };

  if (outgoing.isError) {
    return <AlertBanner tone="danger">{t('channels:loadFailed')}</AlertBanner>;
  }
  if (outgoing.data === undefined) {
    return <Box aria-busy="true" />;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <SmtpCard brandId={brandId} settings={outgoing.data} onSaved={saved} />
          <SendersCard
            brandId={brandId}
            settings={outgoing.data}
            departments={departments.data?.departments ?? []}
            onSaved={saved}
          />
        </Box>
        <AutoRepliesCard brandId={brandId} settings={outgoing.data} onSaved={saved} />
      </Box>
      <FailedSendsCard brandId={brandId} />
    </Box>
  );
}
