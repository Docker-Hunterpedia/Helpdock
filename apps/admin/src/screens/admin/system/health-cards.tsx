import type { ComponentStatus, SystemStatus } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { formatCount, formatDuration, formatMs, secondsSince } from './format.js';
import { captionColor, StatusLabel } from './status-dot.js';

/**
 * The row of four cards at the top of the artboard `Admin/System`: API, Worker,
 * Postgres and Redis. Each says what it is, whether it is well, one mono fact,
 * and one caption explaining the state.
 */

interface HealthCardProps {
  readonly title: string;
  readonly status: ComponentStatus;
  readonly label: string;
  /** The one number that identifies this component: a version, a replica count. */
  readonly fact: string;
  readonly caption: string;
  /** Draws the caption in the status hue, for a card that is warning or failing. */
  readonly captionStatus?: ComponentStatus;
}

function HealthCard({
  title,
  status,
  label,
  fact,
  caption,
  captionStatus = 'ok',
}: HealthCardProps): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="section"
      aria-label={title}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        paddingBlock: '14px',
        paddingInline: 4,
      }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {title}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3 }}>
        <StatusLabel status={status} label={label} />
        <Typography variant="mono" component="span" dir="ltr" sx={{ color: 'text.secondary' }}>
          {fact}
        </Typography>
      </Box>

      <Typography variant="caption" sx={{ color: captionColor(captionStatus, tokens) }}>
        {caption}
      </Typography>
    </Box>
  );
}

export function HealthCards({ status }: { readonly status: SystemStatus }): ReactNode {
  const t = useT();

  const slowest = status.api.checks.reduce((worst, check) => Math.max(worst, check.latencyMs), 0);
  const relay = status.relay;
  const migrations = status.database.migrationsApplied;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
        gap: 4,
        marginBlockEnd: 6,
      }}
    >
      <HealthCard
        title={t('system:cards.api.title')}
        status={status.api.status}
        label={t(`system:status.${status.api.status}`)}
        // The artboard's mono slot holds a replica count. An api replica
        // cannot know how many of it there are — the orchestrator owns that —
        // so it states what it does know: how long this one has been up.
        fact={formatDuration(status.build.uptimeSeconds)}
        caption={t('system:cards.api.caption', {
          checks: formatCount(status.api.checks.length),
          latency: formatMs(slowest),
        })}
        captionStatus={status.api.status}
      />

      <HealthCard
        title={t('system:cards.worker.title')}
        status={relay.reporting ? 'ok' : 'warning'}
        label={t(`system:status.${relay.reporting ? 'ok' : 'warning'}`)}
        fact={relay.reporting ? `${formatMs(relay.durationMs)} ms` : '—'}
        caption={
          relay.reporting
            ? t('system:cards.worker.caption', {
                pending: formatCount(relay.pending),
                ago: formatCount(secondsSince(relay.at)),
              })
            : t('system:cards.worker.notReporting')
        }
        captionStatus={relay.reporting ? 'ok' : 'warning'}
      />

      <HealthCard
        title={t('system:cards.postgres.title')}
        status={status.database.status}
        label={t(
          `system:status.${status.database.status === 'ok' ? 'connected' : status.database.status}`,
        )}
        fact={status.database.version ?? '—'}
        caption={
          status.database.runtimeRole.bypassRls
            ? t('system:cards.postgres.rlsBypassed')
            : t('system:cards.postgres.caption', {
                count: migrations ?? 0,
                role: status.database.runtimeRole.name,
              })
        }
        captionStatus={status.database.runtimeRole.bypassRls ? 'error' : status.database.status}
      />

      <HealthCard
        title={t('system:cards.redis.title')}
        status={status.redis.status}
        label={t(
          `system:status.${status.redis.status === 'ok' ? 'connected' : status.redis.status}`,
        )}
        fact={status.redis.version ?? '—'}
        caption={
          status.redis.aofRewriteInProgress
            ? t('system:cards.redis.aofRewrite', { latency: formatMs(status.redis.latencyMs) })
            : t('system:cards.redis.caption', { latency: formatMs(status.redis.latencyMs) })
        }
        captionStatus={status.redis.status}
      />
    </Box>
  );
}
