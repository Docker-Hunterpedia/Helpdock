import type { MetaPlatform, MetaTicketContext } from '@helpdock/schemas';
import { Box, IconButton, Typography } from '@mui/material';
import { CircleCheck, Copy } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Trans } from 'react-i18next';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useToast } from '../../../ui/toasts.tsx';
import { PLATFORM_ICONS } from '../../admin/channels/meta/platforms.js';
import { accountLabel } from './meta-format.js';

/**
 * DESIGN §6.3 ChannelIdentityCard, Meta rows (M10-03 to M10-05, M10-08,
 * `Admin/Ticket-Meta` panels 1, 7 and 8): who a WhatsApp, Messenger or
 * Instagram customer is, under the contact in the details panel. The same
 * radius md card as Telegram's, on a 72 px label column so long labels wrap to
 * two lines; ids are mono 12 inside `<bdi>` with a 28 px ghost Copy button named
 * after the id ("Copy user id"). The footer says which value Meta verifies and
 * which can change.
 *
 * - **WhatsApp**: User id; Phone with a verified mark, or "Not shared by the
 *   customer" when Meta sent none (a customer who writes with a WhatsApp
 *   username); Profile name; Number, the brand's, with its display name.
 * - **Messenger**: Page-scoped id; Name, or "Messenger user" until the app has
 *   passed the review for profile access; Page.
 * - **Instagram**: Instagram-scoped id; Username; Name; Account.
 */

const IDENTITY_ROWS = {
  whatsapp: { idLabel: 'userId', copy: 'copyUserId' },
  messenger: { idLabel: 'pageScopedId', copy: 'copyPageScopedId' },
  instagram: { idLabel: 'instagramScopedId', copy: 'copyInstagramScopedId' },
} as const satisfies Record<MetaPlatform, { idLabel: string; copy: string }>;

export function ChannelIdentityRows({
  context,
}: {
  readonly context: MetaTicketContext;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const headingId = useId();
  const { account } = context;
  const platform = account.platform;
  const Icon = PLATFORM_ICONS[platform];
  const rows = IDENTITY_ROWS[platform];

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(context.customerId);
      toast({ tone: 'success', message: t('tickets:meta.identity.copied') });
    } catch {
      toast({ tone: 'danger', message: t('tickets:meta.identity.copyFailed') });
    }
  };

  const verified = (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        fontSize: 12,
        fontWeight: 500,
        color: tokens['status.success.text'],
      }}
    >
      <CircleCheck size={14} aria-hidden="true" />
      {t('tickets:meta.identity.verified')}
    </Box>
  );

  const footer = ((): ReactNode => {
    switch (platform) {
      case 'whatsapp':
        return t(
          context.phone === undefined
            ? 'tickets:meta.identity.footerWhatsappNoPhone'
            : 'tickets:meta.identity.footerWhatsapp',
        );
      case 'messenger':
        return t('tickets:meta.identity.footerMessenger');
      case 'instagram':
        return (
          <Trans
            i18nKey="tickets:meta.identity.footerInstagram"
            values={{ account: accountLabel(account) }}
            components={{ bdi: <bdi /> }}
          />
        );
    }
  })();

  const none = (
    <Box component="span" sx={{ color: 'text.secondary' }}>
      {t('tickets:meta.messengerUser')}
    </Box>
  );

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        padding: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.canvas'],
      }}
    >
      <Typography
        id={headingId}
        component="h2"
        sx={{
          fontSize: 12,
          fontWeight: 500,
          color: 'text.secondary',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Icon size={14} aria-hidden="true" />
        {t(`tickets:meta.identity.heading.${platform}`)}
      </Typography>

      <Box
        component="dl"
        sx={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: '72px minmax(0, 1fr)',
          columnGap: 3,
          alignItems: 'start',
          '& dt': { fontSize: 12, fontWeight: 500, color: 'text.secondary', paddingBlock: '6px' },
          '& dd': {
            margin: 0,
            fontSize: 13,
            minHeight: 28,
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '4px 8px',
            minWidth: 0,
          },
        }}
      >
        <dt>{t(`tickets:meta.identity.${rows.idLabel}`)}</dt>
        <dd>
          <Typography variant="mono" component="bdi" sx={{ fontSize: 12, overflowWrap: 'anywhere' }}>
            {context.customerId}
          </Typography>
          <IconButton
            size="small"
            aria-label={t(`tickets:meta.identity.${rows.copy}`)}
            onClick={() => {
              void copy();
            }}
            sx={{ width: 28, height: 28 }}
          >
            <Copy size={14} aria-hidden="true" />
          </IconButton>
        </dd>

        {platform === 'whatsapp' ? (
          <>
            <dt>{t('tickets:meta.identity.phone')}</dt>
            <dd>
              {context.phone === undefined ? (
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {t('tickets:meta.identity.phoneNotShared')}
                </Box>
              ) : (
                <>
                  <bdi>{context.phone}</bdi>
                  {context.phoneVerified ? verified : null}
                </>
              )}
            </dd>
            <dt>{t('tickets:meta.identity.profileName')}</dt>
            <dd>{context.profileName === undefined ? '—' : <bdi dir="auto">{context.profileName}</bdi>}</dd>
            <dt>{t('tickets:meta.identity.number')}</dt>
            <dd style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
              <bdi style={{ fontSize: 12 }}>{accountLabel(account)}</bdi>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                <bdi dir="auto">{account.displayName}</bdi>
              </Typography>
            </dd>
          </>
        ) : null}

        {platform === 'messenger' ? (
          <>
            <dt>{t('tickets:meta.identity.name')}</dt>
            <dd>
              {context.profileName === undefined ? none : <bdi dir="auto">{context.profileName}</bdi>}
            </dd>
            <dt>{t('tickets:meta.identity.page')}</dt>
            <dd>
              <bdi dir="auto">{account.displayName}</bdi>
            </dd>
          </>
        ) : null}

        {platform === 'instagram' ? (
          <>
            <dt>{t('tickets:meta.identity.username')}</dt>
            <dd>
              {context.username === undefined ? '—' : <bdi>@{context.username}</bdi>}
            </dd>
            <dt>{t('tickets:meta.identity.name')}</dt>
            <dd>{context.profileName === undefined ? '—' : <bdi dir="auto">{context.profileName}</bdi>}</dd>
            <dt>{t('tickets:meta.identity.account')}</dt>
            <dd style={{ fontSize: 12 }}>
              <bdi>{accountLabel(account)}</bdi>
            </dd>
          </>
        ) : null}
      </Box>

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {footer}
      </Typography>
    </Box>
  );
}
