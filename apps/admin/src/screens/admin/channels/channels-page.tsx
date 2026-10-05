import type { EmailOutgoingSettings } from '@helpdock/schemas';
import { Box, Button, Tab, Tabs } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { channelsRoute, ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useEmailApi, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { emailKeys } from '../../../email/api.js';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { AutoRepliesCard } from './auto-replies-card.tsx';
import { FailedSendsCard } from './failed-sends-card.tsx';
import { MailboxesTab } from './mailboxes-tab.tsx';
import { SendersCard } from './senders-card.tsx';
import { SmtpCard } from './smtp-card.tsx';
import { type ChannelsTab, channelsTabForSegment, channelsTabsFor } from './tabs.js';
import { TelegramBotPage } from './telegram/bot-page.tsx';
import { TelegramTab } from './telegram/telegram-tab.tsx';
import { WebFormTab } from './web-form-tab.tsx';
import { WidgetTab } from './widget/widget-tab.tsx';

/**
 * `Admin/Channels` (M2-08; artboards `Admin · email channel` for Mailboxes,
 * `AdminEmailOutgoing` for Outgoing email, `AdminWidget` for Widget, M4, and
 * `AdminWebForm` for Web form, M4-09, `Admin/Channels-Telegram` for Telegram,
 * M6-05):
 * the page header, the tab row of the tabs the viewer's role may open, and
 * the tab the url names. The tabs are links, as on Ticketing, so a tab is a
 * url and back works. "Add mailbox" belongs to the Mailboxes tab alone, and
 * "Add bot" to the Telegram list; a bot's page is the Telegram tab too.
 */
export function ChannelsPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment, botId } = useParams();
  const tabs = channelsTabsFor(session.user.role);
  const [addingBot, setAddingBot] = useState(false);

  const tab = channelsTabForSegment(botId === undefined ? segment : 'telegram', session.user.role);
  const landing = tabs[0];
  if (tab === undefined) {
    return landing === undefined ? null : <Navigate to={channelsRoute(landing.segment)} replace />;
  }

  return (
    <>
      <PageHeader
        title={t('channels:title')}
        caption={t('channels:subtitle', { brand: brand.name })}
        action={
          tab.key === 'mailboxes' ? (
            <Button
              variant="contained"
              component={Link}
              to={ROUTES.mailboxNew}
              startIcon={<Plus size={16} aria-hidden="true" />}
            >
              {t('channels:addMailbox')}
            </Button>
          ) : tab.key === 'telegram' && botId === undefined ? (
            <Button
              variant="contained"
              aria-haspopup="dialog"
              startIcon={<Plus size={16} aria-hidden="true" />}
              onClick={() => {
                setAddingBot(true);
              }}
            >
              {t('channels:addBot')}
            </Button>
          ) : undefined
        }
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('channels:tabList')}>
          {tabs.map(({ key, segment: path, icon: Icon }) => (
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

      <TabBody
        tab={tab}
        brandId={brand.id}
        botId={botId}
        addingBot={addingBot}
        onAddingBotChange={setAddingBot}
      />
    </>
  );
}

function TabBody({
  tab,
  brandId,
  botId,
  addingBot,
  onAddingBotChange,
}: {
  readonly tab: ChannelsTab;
  readonly brandId: string;
  /** A bot's page, under the Telegram tab. */
  readonly botId: string | undefined;
  readonly addingBot: boolean;
  onAddingBotChange(open: boolean): void;
}): ReactNode {
  switch (tab.key) {
    case 'mailboxes':
      return <MailboxesTab />;
    case 'outgoing':
      return <OutgoingTab brandId={brandId} />;
    case 'widget':
      return <WidgetTab />;
    case 'webForm':
      return <WebFormTab />;
    case 'telegram':
      return botId === undefined ? (
        <TelegramTab adding={addingBot} onAddingChange={onAddingBotChange} />
      ) : (
        <TelegramBotPage botId={botId} />
      );
  }
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
