import type { TelegramBot, TelegramBotStatus } from '@helpdock/schemas';
import { Box, Button, CircularProgress, IconButton, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Info, Webhook } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { telegramKeys } from '../../../../telegram/api.js';
import { useTelegramApi } from '../../../../telegram/context.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { clockTime } from '../format.js';
import { HealthStateDot } from '../health.tsx';
import { FormSection } from './form-section.tsx';

/**
 * Webhook: where Telegram should post, what Telegram says about it
 * (`getWebhookInfo`: pending updates, its last delivery error), and Set
 * webhook. A development install polls instead, which is said here and keeps
 * the button off.
 */
export function WebhookSection({
  bot,
  status,
  checkedAt,
}: {
  readonly bot: TelegramBot;
  /** Undefined while Telegram is being asked. */
  readonly status: TelegramBotStatus | undefined;
  readonly checkedAt: number;
}): ReactNode {
  const t = useT();
  const api = useTelegramApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const polling = bot.mode === 'polling';

  const set = useMutation({
    mutationFn: () => api.setWebhook(brand.id, bot.id),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({
          tone: 'danger',
          message: t('channels:telegram.detail.webhook.refused', { detail: result.detail ?? '' }),
        });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: telegramKeys.bot(brand.id, bot.id) });
      await queryClient.invalidateQueries({ queryKey: telegramKeys.bots(brand.id) });
      toast({
        tone: 'success',
        message: t('channels:telegram.toast.webhookSet', { username: bot.username }),
      });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(bot.webhook.expectedUrl);
      toast({ tone: 'success', message: t('channels:telegram.toast.copied') });
    } catch {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    }
  };

  const registered = status?.webhook ?? null;
  const pointsHere = registered !== null && registered.url === bot.webhook.expectedUrl;
  const state = polling ? 'polling' : pointsHere ? 'set' : registered?.url ? 'elsewhere' : 'notSet';

  return (
    <FormSection
      heading={t('channels:telegram.detail.webhook.heading')}
      caption={t('channels:telegram.detail.webhook.caption')}
    >
      <Box
        component="dl"
        sx={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, max-content) minmax(0, 1fr)',
          columnGap: 6,
          rowGap: 2,
          fontSize: 13,
          '& dt': { color: 'text.secondary' },
          '& dd': { margin: 0, minWidth: 0 },
        }}
      >
        <dt>{t('channels:telegram.detail.webhook.state')}</dt>
        <dd>
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <HealthStateDot state={state === 'set' ? 'healthy' : 'waiting'} />
            <Box component="span" sx={{ fontWeight: 500 }}>
              {t(`channels:telegram.detail.webhook.${state}`)}
            </Box>
            {status === undefined ? null : (
              <Typography
                variant="mono"
                component="span"
                sx={{ fontSize: 12, color: 'text.secondary' }}
              >
                ·{' '}
                {t('channels:telegram.detail.webhook.checked', {
                  time: clockTime(new Date(checkedAt).toISOString(), locale),
                })}
              </Typography>
            )}
          </Box>
        </dd>

        <dt>{t('channels:telegram.detail.webhook.address')}</dt>
        <dd>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Typography
              variant="mono"
              component="code"
              dir="ltr"
              sx={{ fontSize: 12, overflowWrap: 'anywhere' }}
            >
              {bot.webhook.expectedUrl}
            </Typography>
            <IconButton
              size="small"
              aria-label={t('channels:telegram.detail.webhook.copy')}
              onClick={() => {
                void copy();
              }}
            >
              <Copy size={14} aria-hidden="true" />
            </IconButton>
          </Box>
        </dd>

        <dt>{t('channels:telegram.detail.webhook.secret')}</dt>
        <dd>{t('channels:telegram.detail.webhook.secretBody')}</dd>

        {status?.webhook === null || status === undefined ? null : (
          <>
            <dt>{t('channels:telegram.detail.webhook.pending')}</dt>
            <dd>
              <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
                {status.webhook.pendingUpdateCount}
              </Typography>
            </dd>
            <dt>{t('channels:telegram.detail.webhook.lastError')}</dt>
            <dd
              style={
                status.webhook.lastErrorMessage === null
                  ? undefined
                  : { color: tokens['status.danger.text'] }
              }
            >
              {status.webhook.lastErrorMessage ?? t('channels:telegram.detail.webhook.none')}
            </dd>
          </>
        )}
      </Box>

      {status?.webhookError == null ? null : (
        <Typography variant="caption" role="status" sx={{ color: tokens['status.warning.text'] }}>
          {t('channels:telegram.detail.webhook.unknown', { detail: status.webhookError })}
        </Typography>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          disabled={polling || set.isPending}
          aria-busy={set.isPending}
          startIcon={
            set.isPending ? (
              <CircularProgress size={14} aria-hidden="true" />
            ) : (
              <Webhook size={16} aria-hidden="true" />
            )
          }
          onClick={() => {
            set.mutate();
          }}
        >
          {t('channels:telegram.detail.webhook.button')}
        </Button>
        <Typography variant="caption" sx={{ color: 'text.secondary', flex: '1 1 240px' }}>
          {t('channels:telegram.detail.webhook.hint')}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'flex',
          gap: 2,
          alignItems: 'flex-start',
          paddingBlock: 2,
          paddingInline: 3,
          borderRadius: '6px',
          backgroundColor: tokens['bg.muted'],
          color: 'text.secondary',
          fontSize: 12,
        }}
      >
        <Info size={14} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
        {t('channels:telegram.detail.webhook.pollingNote')}
      </Box>
    </FormSection>
  );
}
