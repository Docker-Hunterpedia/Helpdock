import type { TelegramDelivery } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { Check, RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * Whether Telegram has an agent's reply (M6-02, `Admin/Ticket-Telegram`):
 * "Sent" after the reply's time, and under one Telegram refused for good the
 * danger strip with its words, the tries and Retry — the same strip as an
 * email that bounced.
 */

export function DeliveryState({ delivery }: { readonly delivery: TelegramDelivery }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (delivery.status === 'failed') {
    return null;
  }

  return (
    <>
      <span aria-hidden="true"> · </span>
      {delivery.status === 'sent' ? (
        <Box
          component="span"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: '2px', verticalAlign: 'middle' }}
        >
          <Check size={12} aria-hidden="true" color={tokens['status.success']} />
          {t('tickets:telegram.sent')}
        </Box>
      ) : (
        t('tickets:telegram.queued')
      )}
    </>
  );
}

export function TelegramDeliveryFailure({
  delivery,
  busy,
  onRetry,
}: {
  readonly delivery: TelegramDelivery;
  readonly busy: boolean;
  onRetry(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        marginBlockStart: 2,
        paddingBlock: 1,
        paddingInline: 3,
        borderRadius: '6px',
        border: `1px solid ${tokens['status.danger']}`,
        backgroundColor: tokens['status.danger.tint'],
        color: tokens['status.danger.text'],
      }}
    >
      <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
      <Typography
        variant="caption"
        role="status"
        sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
      >
        <strong>{t('tickets:telegram.notDelivered')}</strong> ·{' '}
        {t('tickets:telegram.notDeliveredDetail', {
          error: delivery.lastError ?? '—',
          attempts: delivery.attempts,
        })}
      </Typography>
      <Button
        size="small"
        variant="text"
        disabled={busy}
        startIcon={<RotateCw size={12} aria-hidden="true" />}
        onClick={onRetry}
        aria-label={t('tickets:telegram.retryLabel')}
        sx={{ color: 'inherit' }}
      >
        {t('tickets:telegram.retry')}
      </Button>
    </Box>
  );
}
