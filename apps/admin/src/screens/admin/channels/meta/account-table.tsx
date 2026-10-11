import type { MetaAccount } from '@helpdock/schemas';
import {
  Box,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { Check, CircleAlert, Pencil, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { metaAccountRoute } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { ActionsMenu } from '../../../../ui/actions-menu.tsx';
import { visuallyHidden } from '../../../../ui/visually-hidden.js';
import { ago, clockTime, shortDate } from '../format.js';
import { AccountHealth, accountHealthView } from './account-health.tsx';
import { accountLabel, accountSublabel, PLATFORM_ICONS } from './platforms.js';

/**
 * DESIGN §6.3 MetaAccountTable (M10-07, M10-10; `Admin/Channels-Meta`): the
 * brand's connected accounts in one table with a platform column — the number,
 * Page or account, where it routes, whether Meta posts its messages to Helpdock,
 * the last event and the health, a failing row adding Meta's words and Fix.
 * "Disconnect" in a row's menu asks the tab to open the typed confirmation.
 */
export function AccountTable({
  accounts,
  loading,
  onDisconnect,
}: {
  readonly accounts: readonly MetaAccount[];
  readonly loading: boolean;
  onDisconnect(account: MetaAccount): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const navigate = useNavigate();
  const headingId = useId();
  const [now] = useState(Date.now);

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      aria-busy={loading}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          paddingBlock: '14px',
          paddingInline: 4,
          display: 'flex',
          alignItems: 'baseline',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
          {t('channels:meta.heading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:meta.caption', { count: accounts.length })}
        </Typography>
      </Box>

      <TableContainer>
        <Table aria-labelledby={headingId} sx={{ tableLayout: 'fixed', minWidth: 880 }}>
          <TableHead>
            <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableCell sx={{ width: 120 }}>{t('channels:meta.columns.platform')}</TableCell>
              <TableCell>{t('channels:meta.columns.account')}</TableCell>
              <TableCell sx={{ width: 100 }}>{t('channels:meta.columns.routesTo')}</TableCell>
              <TableCell sx={{ width: 170 }}>{t('channels:meta.columns.subscription')}</TableCell>
              <TableCell sx={{ width: 170 }}>{t('channels:meta.columns.lastEvent')}</TableCell>
              <TableCell sx={{ width: 210 }}>{t('channels:meta.columns.health')}</TableCell>
              <TableCell sx={{ width: 48 }}>
                <Box component="span" sx={visuallyHidden}>
                  {t('channels:meta.columns.actions')}
                </Box>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {accounts.map((account) => {
              const name = accountLabel(account);
              const Icon = PLATFORM_ICONS[account.platform];
              return (
                <TableRow key={account.id}>
                  <TableCell>
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <Icon size={16} aria-hidden="true" />
                      {t(`channels:meta.platforms.${account.platform}`)}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <MuiLink
                      component={Link}
                      to={metaAccountRoute(account.id)}
                      sx={{ color: 'text.primary', fontWeight: 500, display: 'block' }}
                    >
                      <bdi>{name}</bdi>
                    </MuiLink>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      <bdi>
                        {accountSublabel(account, t(`channels:meta.kinds.${account.platform}`))}
                      </bdi>
                    </Typography>
                  </TableCell>
                  <TableCell>{account.departmentName}</TableCell>
                  <TableCell>
                    <SubscriptionCell account={account} />
                  </TableCell>
                  <TableCell>
                    <LastEvent account={account} now={now} />
                  </TableCell>
                  <TableCell>
                    <HealthCell account={account} now={now} />
                  </TableCell>
                  <TableCell>
                    <ActionsMenu
                      label={t('channels:meta.actionsFor', { name })}
                      menuLabel={t('channels:meta.actionsFor', { name })}
                      items={[
                        {
                          id: 'open',
                          label: t('channels:meta.open'),
                          icon: Pencil,
                          onSelect: () => {
                            void navigate(metaAccountRoute(account.id));
                          },
                        },
                        {
                          id: 'disconnect',
                          label: t('channels:meta.disconnect'),
                          icon: Trash2,
                          tone: 'danger',
                          dividerBefore: true,
                          onSelect: () => {
                            onDisconnect(account);
                          },
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

/** "Subscribed", "Not subscribed", or "Not checked since 09:00" for a token Meta no longer honours. */
function SubscriptionCell({ account }: { readonly account: MetaAccount }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();

  if (account.status === 'token_expired') {
    return (
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          fontSize: 13,
          color: 'text.secondary',
        }}
      >
        <CircleAlert size={14} aria-hidden="true" />
        {account.subscribedAt === null
          ? t('channels:meta.subscription.notCheckedYet')
          : t('channels:meta.subscription.notChecked', {
              time: clockTime(account.subscribedAt, locale),
            })}
      </Box>
    );
  }
  if (account.status === 'unsubscribed' || account.subscribedAt === null) {
    return (
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          fontSize: 13,
          color: tokens['status.warning.text'],
        }}
      >
        <CircleAlert size={14} aria-hidden="true" />
        {t('channels:meta.subscription.notSubscribed')}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        fontSize: 13,
        color: tokens['status.success.text'],
      }}
    >
      <Check size={14} aria-hidden="true" />
      {t('channels:meta.subscription.subscribed')}
    </Box>
  );
}

function LastEvent({
  account,
  now,
}: {
  readonly account: MetaAccount;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const at = account.lastEventAt;

  return (
    <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
      {at === null
        ? t('channels:meta.noEvent')
        : t('channels:meta.lastEvent', { time: clockTime(at, locale), ago: ago(at, now, locale) })}
    </Typography>
  );
}

/** The state, its time, Fix and — for a failing row — Meta's own words. */
function HealthCell({
  account,
  now,
}: {
  readonly account: MetaAccount;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const view = accountHealthView(account, now);
  const name = accountLabel(account);
  const at = view === 'failing' ? account.lastErrorAt : null;

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 2 }}>
        <AccountHealth account={account} now={now} />
        {at === null ? null : (
          <Typography
            variant="mono"
            component="span"
            sx={{ fontSize: 12, color: 'text.secondary' }}
          >
            {clockTime(at, locale)}
          </Typography>
        )}
        {view === 'failing' ? (
          <MuiLink
            component={Link}
            to={metaAccountRoute(account.id)}
            aria-label={t('channels:meta.health.fixFor', { name })}
            sx={{ fontSize: 12, fontWeight: 500 }}
          >
            {t('channels:meta.health.fix')}
          </MuiLink>
        ) : null}
        {view === 'waiting' ? (
          <Typography
            variant="mono"
            component="span"
            sx={{ fontSize: 12, color: 'text.secondary' }}
          >
            {t('channels:meta.health.connectedAt', { time: clockTime(account.createdAt, locale) })}
          </Typography>
        ) : null}
        {view === 'expiring' && account.tokenExpiresAt !== null ? (
          <Typography
            variant="mono"
            component="span"
            sx={{ fontSize: 12, color: 'text.secondary' }}
          >
            {t('channels:meta.health.expiresOn', {
              date: shortDate(account.tokenExpiresAt, locale),
            })}
          </Typography>
        ) : null}
      </Box>
      {view === 'failing' && account.lastError !== null ? (
        <Typography
          variant="caption"
          component="p"
          dir="auto"
          sx={{
            color: tokens['status.danger.text'],
            fontSize: 12,
            lineHeight: '16px',
            overflowWrap: 'anywhere',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {t('channels:meta.health.metaSaid', { error: account.lastError })}
        </Typography>
      ) : null}
    </Box>
  );
}
