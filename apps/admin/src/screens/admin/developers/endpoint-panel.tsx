import type { WebhookOverview } from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { Pencil, Power, PowerOff, RefreshCw, Send } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { shortDate } from '../channels/format.js';
import { Card } from './card.tsx';
import { MonoTags } from './mono-tag.tsx';

/** What a stored secret looks like on screen: never its value, which never reaches the browser. */
const SECRET_MASK = '••••••••••••••••';

/**
 * The open endpoint (`Admin/Developers-Webhooks`, under the table): its URL,
 * who added it, its events, and its signing secret as a SecretField (DESIGN
 * §6.1) with Rotate. "Send test event", Edit and Turn off sit in its header.
 */
export function EndpointPanel({
  webhook,
  busy,
  onTest,
  onEdit,
  onToggle,
  onRotate,
}: {
  readonly webhook: WebhookOverview;
  readonly busy: boolean;
  onTest(): void;
  onEdit(): void;
  onToggle(): void;
  onRotate(): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const headingId = useId();
  const secretId = useId();
  const added = shortDate(webhook.createdAt, locale);
  const events =
    webhook.events.length === 1
      ? t('developers:webhooks.panel.eventCountOne')
      : t('developers:webhooks.panel.eventCount', { n: webhook.events.length });
  const state = t(webhook.enabled ? 'developers:webhooks.active' : 'developers:webhooks.turnedOff');
  const secretDate = shortDate(webhook.secretRotatedAt ?? webhook.createdAt, locale);
  // Who rotated a secret is in the audit log, not on the endpoint: only the
  // first one is known to be the creator's.
  const secretHint =
    webhook.secretRotatedAt === null && webhook.createdByName !== null
      ? t('developers:webhooks.panel.secretSetBy', {
          name: webhook.createdByName,
          date: secretDate,
        })
      : t('developers:webhooks.panel.secretSet', { date: secretDate });

  return (
    <Card labelledBy={headingId}>
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 320px' }}>
            <Typography
              id={headingId}
              variant="h3"
              component="h2"
              dir="ltr"
              sx={{
                fontFamily: 'var(--hd-font-mono, monospace)',
                fontSize: 16,
                overflowWrap: 'anywhere',
                alignSelf: 'flex-start',
              }}
            >
              {webhook.url}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {webhook.createdByName === null
                ? t('developers:webhooks.panel.metaNobody', { date: added, events, state })
                : t('developers:webhooks.panel.meta', {
                    name: webhook.createdByName,
                    date: added,
                    events,
                    state,
                  })}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<Send size={14} aria-hidden="true" />}
              aria-label={t('developers:webhooks.test.sendFor', { url: webhook.url })}
              disabled={busy}
              onClick={onTest}
            >
              {t('developers:webhooks.test.send')}
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<Pencil size={14} aria-hidden="true" />}
              disabled={busy}
              onClick={onEdit}
            >
              {t('developers:webhooks.menu.edit')}
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={
                webhook.enabled ? (
                  <PowerOff size={14} aria-hidden="true" />
                ) : (
                  <Power size={14} aria-hidden="true" />
                )
              }
              disabled={busy}
              onClick={onToggle}
            >
              {t(
                webhook.enabled
                  ? 'developers:webhooks.menu.turnOff'
                  : 'developers:webhooks.menu.turnOn',
              )}
            </Button>
          </Box>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
            gap: 6,
          }}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography component="h3" sx={{ fontSize: 13, fontWeight: 500 }}>
              {t('developers:webhooks.panel.events')}
            </Typography>
            <MonoTags values={webhook.events} label={t('developers:webhooks.panel.events')} />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <Typography component="label" htmlFor={secretId} sx={{ fontSize: 13, fontWeight: 500 }}>
              {t('developers:webhooks.panel.secret')}
            </Typography>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                id={secretId}
                size="small"
                value={SECRET_MASK}
                slotProps={{
                  htmlInput: {
                    readOnly: true,
                    'aria-describedby': `${secretId}-hint`,
                  },
                }}
                sx={{ flexGrow: 1, minWidth: 0 }}
              />
              <Button
                variant="outlined"
                color="inherit"
                startIcon={<RefreshCw size={16} aria-hidden="true" />}
                disabled={busy}
                onClick={onRotate}
                sx={{ flexShrink: 0 }}
              >
                {t('developers:webhooks.panel.rotate')}
              </Button>
            </Box>
            <Typography id={`${secretId}-hint`} variant="caption" sx={{ color: 'text.secondary' }}>
              {secretHint}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Card>
  );
}
