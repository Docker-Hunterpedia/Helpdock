import type { AuditEntry, ChannelStatus, SystemAiSpend, SystemStorage } from '@helpdock/schemas';
import { Box, Link, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Card } from './card.js';
import { formatBytes, formatCompact, formatUsd, percentOf } from './format.js';
import { captionColor, StatusDot } from './status-dot.js';

/** The three panels down the end column of the artboard `Admin/System`. */

export function ChannelsCard({
  channels,
}: {
  readonly channels: readonly ChannelStatus[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Card title={t('system:channels.title')}>
      {channels.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:channels.empty')}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 3 }}
        >
          {channels.map((channel) => (
            <Box
              component="li"
              key={channel.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 3,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
                <StatusDot status={channel.status} />
                <Typography variant="body2" component="span" noWrap>
                  {channel.name} · {channel.kind}
                </Typography>
              </Box>
              <Typography
                variant="caption"
                component="span"
                sx={{ color: captionColor(channel.status, tokens), whiteSpace: 'nowrap' }}
              >
                {channel.detail}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Card>
  );
}

/** A 4 px bar under a stat tile, in the accent or the warning hue. */
function Meter({ percent, warning }: { readonly percent: number; readonly warning: boolean }) {
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        height: 4,
        borderRadius: '999px',
        backgroundColor: tokens['bg.muted'],
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          width: `${percent}%`,
          height: '100%',
          backgroundColor: warning ? tokens['status.warning'] : tokens['action.primary'],
        }}
      />
    </Box>
  );
}

function StatTile({
  label,
  value,
  caption,
  meter,
}: {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly meter?: ReactNode;
}): ReactNode {
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography variant="h3" component="p" dir="ltr" sx={{ textAlign: 'start' }}>
        {value}
      </Typography>
      {meter}
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {caption}
      </Typography>
    </Box>
  );
}

export function UsageCard({
  storage,
  aiSpend,
}: {
  readonly storage: SystemStorage;
  readonly aiSpend: SystemAiSpend;
}): ReactNode {
  const t = useT();

  const storagePercent =
    storage.configured && storage.softLimitBytes !== null
      ? percentOf(storage.usedBytes, storage.softLimitBytes)
      : 0;

  const spendPercent =
    aiSpend.configured && aiSpend.budgetUsd !== null
      ? percentOf(aiSpend.costUsd, aiSpend.budgetUsd)
      : 0;

  const overAlert =
    aiSpend.configured && aiSpend.alertAtPercent !== null && spendPercent >= aiSpend.alertAtPercent;

  return (
    <Card title={t('system:usage.title')}>
      <Box sx={{ display: 'grid', gap: 5 }}>
        <StatTile
          label={t('system:usage.storage')}
          // Nothing measures the bucket until M1, and a zero here would read as
          // an empty bucket rather than as an unanswered question.
          value={storage.configured ? formatBytes(storage.usedBytes) : t('system:notConfigured')}
          caption={
            storage.configured && storage.softLimitBytes !== null
              ? t('system:usage.storageLimit', { limit: formatBytes(storage.softLimitBytes) })
              : t('system:usage.storagePending')
          }
          {...(storage.configured && storage.softLimitBytes !== null
            ? { meter: <Meter percent={storagePercent} warning={storagePercent >= 100} /> }
            : {})}
        />

        <StatTile
          label={t('system:usage.ai')}
          value={
            aiSpend.configured
              ? `${formatCompact(aiSpend.tokens)} · ${formatUsd(aiSpend.costUsd)}`
              : t('system:notConfigured')
          }
          caption={
            aiSpend.configured && aiSpend.budgetUsd !== null
              ? t('system:usage.aiBudget', {
                  percent: spendPercent,
                  budget: formatUsd(aiSpend.budgetUsd),
                  alert: aiSpend.alertAtPercent ?? 0,
                })
              : t('system:usage.aiPending')
          }
          {...(aiSpend.configured && aiSpend.budgetUsd !== null
            ? { meter: <Meter percent={spendPercent} warning={overAlert} /> }
            : {})}
        />
      </Box>
    </Card>
  );
}

/** The artboard shows three rows; the read carries ten. */
const AUDIT_PREVIEW_ROWS = 3;

/**
 * The audit rows the install-scope read returned: the newest three, and
 * "Open" to the full viewer (M3-08, artboard `AdminAuditLog`).
 */
export function AuditCard({ audit }: { readonly audit: readonly AuditEntry[] }): ReactNode {
  const t = useT();
  const preview = audit.slice(0, AUDIT_PREVIEW_ROWS);

  return (
    <Card
      title={t('system:audit.title')}
      action={
        <Link component={RouterLink} to={ROUTES.systemAuditLog} variant="caption">
          {t('system:audit.open')}
        </Link>
      }
    >
      {preview.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:audit.empty')}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}
        >
          {preview.map((entry) => (
            <Box component="li" key={entry.id}>
              <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }} noWrap>
                {t('system:audit.entry', {
                  action: entry.action,
                  target: entry.targetId ?? entry.targetType,
                })}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Card>
  );
}
