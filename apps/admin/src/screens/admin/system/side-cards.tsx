import type { AuditEntry, ChannelStatus } from '@helpdock/schemas';
import { Box, Link, Typography } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Card } from './card.js';
import { formatCount } from './format.js';
import { captionColor, StatusDot } from './status-dot.js';

/** Channels and Audit log, two panels of `Admin/System-1.0`. */

const CHANNEL_KINDS: readonly ChannelStatus['kind'][] = [
  'email',
  'telegram',
  'widget',
  'form',
  'api',
];

/**
 * Every brand's channel connections, grouped by kind as `Admin/System-1.0`
 * draws them (M8-05), with how many need attention at the header's end.
 */
export function ChannelsCard({
  channels,
}: {
  readonly channels: readonly ChannelStatus[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const attention = channels.filter((channel) => channel.status !== 'ok').length;

  return (
    <Card
      title={t('system:channels.title')}
      action={
        attention === 0 ? null : (
          <Typography variant="caption" sx={{ color: tokens['status.danger.text'] }}>
            {t('system:channels.attention', { count: attention })}
          </Typography>
        )
      }
    >
      {channels.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:channels.empty')}
        </Typography>
      ) : (
        <Box sx={{ display: 'grid', gap: 4 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('system:channels.caption', { count: channels.length })}
          </Typography>
          {CHANNEL_KINDS.map((kind) => {
            const group = channels.filter((channel) => channel.kind === kind);
            return group.length === 0 ? null : (
              <ChannelGroup key={kind} kind={kind} channels={group} />
            );
          })}
        </Box>
      )}
    </Card>
  );
}

function ChannelGroup({
  kind,
  channels,
}: {
  readonly kind: ChannelStatus['kind'];
  readonly channels: readonly ChannelStatus[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, marginBlockEnd: 2 }}>
        <Typography id={headingId} variant="caption" component="h3" sx={{ margin: 0 }}>
          {t(`system:channels.kinds.${kind}`)}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {formatCount(channels.length)}
        </Typography>
      </Box>
      <Box
        component="ul"
        aria-labelledby={headingId}
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
            <Typography variant="body2" component="span" noWrap>
              {channel.name}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <StatusDot status={channel.status} />
              <Typography
                variant="caption"
                component="span"
                sx={{ color: captionColor(channel.status, tokens), whiteSpace: 'nowrap' }}
              >
                {channel.detail}
              </Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
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
