import type { MetaAccount } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Network, Plus } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { EmptyState } from '../../../../shell/empty-state.tsx';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { LoadingSkeleton } from '../../../../ui/loading-skeleton.tsx';
import { NoteCard } from '../note-card.tsx';
import { AccountHealthLegend } from './account-health.tsx';
import { AccountTable } from './account-table.tsx';
import { appIsConfigured, MetaAppCard, useMetaApp } from './app-card.tsx';
import { ConnectAccountDialog } from './connect-account-dialog.tsx';
import { DisconnectDialog } from './disconnect-dialog.tsx';
import { PlatformsCard } from './platforms-card.tsx';

/**
 * Channels › Meta (M10-07, `Admin/Channels-Meta`): the Meta app card for
 * install admins, the brand's accounts with where they route, whether Meta
 * posts their messages and their health; "How messages arrive" and the legend
 * under them; and the Connect and Disconnect dialogs over the list. With no
 * account, the empty state replaces the table. "Connect account" sits in the
 * page header, which owns `connecting`.
 */
export function MetaTab({
  connecting,
  onConnectingChange,
}: {
  readonly connecting: boolean;
  onConnectingChange(open: boolean): void;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const session = useSession();
  const brand = currentBrand(session);
  const [disconnecting, setDisconnecting] = useState<MetaAccount | null>(null);
  const blockedId = useId();

  const accounts = useQuery({
    queryKey: metaKeys.accounts(brand.id),
    queryFn: () => api.accounts(brand.id),
  });
  const app = useMetaApp(session.user.installAdmin);

  if (accounts.isError) {
    return <AlertBanner tone="danger">{t('channels:loadFailed')}</AlertBanner>;
  }

  const rows = accounts.data?.accounts ?? [];
  const lastEventAt = rows.reduce<string | null>(
    (latest, account) =>
      account.lastEventAt !== null && (latest === null || account.lastEventAt > latest)
        ? account.lastEventAt
        : latest,
    null,
  );
  const blocked = app.data !== undefined && !appIsConfigured(app.data);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {session.user.installAdmin ? (
        app.isError ? (
          <AlertBanner tone="danger">{t('channels:meta.app.loadFailed')}</AlertBanner>
        ) : app.data === undefined ? (
          <LoadingSkeleton />
        ) : (
          <MetaAppCard app={app.data} lastEventAt={lastEventAt} />
        )
      ) : null}

      {rows.length === 0 && !accounts.isPending ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) minmax(0, 1fr)' },
            gap: 6,
            alignItems: 'start',
          }}
        >
          <EmptyState
            icon={Network}
            heading={t('channels:meta.empty.heading')}
            body={t('channels:meta.empty.body')}
            action={
              <>
                <Button
                  variant="contained"
                  aria-haspopup="dialog"
                  disabled={blocked}
                  {...(blocked ? { 'aria-describedby': blockedId } : {})}
                  startIcon={<Plus size={16} aria-hidden="true" />}
                  onClick={() => {
                    onConnectingChange(true);
                  }}
                >
                  {t('channels:meta.addAccount')}
                </Button>
                {blocked ? (
                  <Typography
                    id={blockedId}
                    variant="caption"
                    sx={{ color: 'text.secondary', maxWidth: 360 }}
                  >
                    {t('channels:meta.empty.blocked')}
                  </Typography>
                ) : null}
              </>
            }
          />
          <PlatformsCard />
        </Box>
      ) : (
        <AccountTable
          accounts={rows}
          loading={accounts.isPending}
          onDisconnect={setDisconnecting}
        />
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <NoteCard heading={t('channels:meta.arrive.heading')}>
          {t('channels:meta.arrive.body')}
        </NoteCard>
        <NoteCard heading={t('channels:meta.legend.heading')}>
          <AccountHealthLegend />
          <Typography variant="caption" component="p" sx={{ marginBlockStart: 2 }}>
            {t('channels:meta.legend.note')}
          </Typography>
        </NoteCard>
      </Box>

      <ConnectAccountDialog
        open={connecting}
        onClose={() => {
          onConnectingChange(false);
        }}
      />
      <DisconnectDialog
        account={disconnecting}
        onClose={() => {
          setDisconnecting(null);
        }}
      />
    </Box>
  );
}
