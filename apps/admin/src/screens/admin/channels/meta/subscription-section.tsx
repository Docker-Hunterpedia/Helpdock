import type { MetaAccount, MetaAccountStatusResponse } from '@helpdock/schemas';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { clockTime } from '../format.js';
import { HealthStateDot } from '../health.tsx';
import { FormSection } from '../telegram/form-section.tsx';
import { accountLabel } from './platforms.js';

/**
 * Subscription (M10-07, M10-10): whether Meta posts this account's messages to
 * Helpdock — the state, the webhook fields it is subscribed to, when the health
 * job last looked, and Meta's last problem — and Subscribe now, which asks Meta
 * again. A dead token cannot be asked, and the state says "not checked" until
 * the account is reconnected.
 */
export function SubscriptionSection({
  account,
  status,
}: {
  readonly account: MetaAccount;
  /** Undefined while Meta is being asked. */
  readonly status: MetaAccountStatusResponse | undefined;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();

  const subscribe = useMutation({
    mutationFn: () => api.subscribe(brand.id, account.id),
    onSuccess: async (result) => {
      // A refusal is read again too: the api records it on the account, and a token Meta calls
      // dead makes it `token_expired`, which is when the page must offer Reconnect.
      await queryClient.invalidateQueries({ queryKey: metaKeys.account(brand.id, account.id) });
      await queryClient.invalidateQueries({ queryKey: metaKeys.accounts(brand.id) });
      if (!result.ok) {
        toast({
          tone: 'danger',
          message: t('channels:meta.detail.subscription.refused', { detail: result.detail ?? '' }),
        });
        return;
      }
      toast({
        tone: 'success',
        message: t('channels:meta.toast.subscribed', { name: accountLabel(account) }),
      });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const expired = account.status === 'token_expired';
  const subscribed = !expired && account.status === 'connected' && account.subscribedAt !== null;
  const state = expired ? 'notChecked' : subscribed ? 'subscribed' : 'notSubscribed';
  const checkedAt = status?.subscriptionCheckedAt ?? null;

  return (
    <FormSection
      heading={t('channels:meta.detail.subscription.heading')}
      caption={t('channels:meta.detail.subscription.caption')}
    >
      <Box
        component="dl"
        sx={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, max-content) minmax(0, 1fr)',
          columnGap: 6,
          rowGap: 2,
          typography: 'body2',
          '& dt': { color: 'text.secondary' },
          '& dd': { margin: 0, minWidth: 0 },
        }}
      >
        <dt>{t('channels:meta.detail.subscription.state')}</dt>
        <dd>
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <HealthStateDot state={subscribed ? 'healthy' : 'waiting'} />
            <Box component="span" sx={{ fontWeight: 500 }}>
              {t(`channels:meta.detail.subscription.${state}`)}
            </Box>
          </Box>
        </dd>

        <dt>{t('channels:meta.detail.subscription.fields')}</dt>
        <dd>
          {account.subscribedFields.length === 0 || !subscribed ? (
            t('channels:meta.detail.subscription.noFields')
          ) : (
            <Box
              component="ul"
              sx={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 1,
              }}
            >
              {account.subscribedFields.map((field) => (
                <Box
                  component="li"
                  key={field}
                  dir="ltr"
                  sx={{
                    height: 24,
                    paddingInline: 2,
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderRadius: '6px',
                    typography: 'mono',
                    fontWeight: 500,
                    backgroundColor: tokens['bg.canvas'],
                    border: `1px solid ${tokens['border.default']}`,
                  }}
                >
                  {field}
                </Box>
              ))}
            </Box>
          )}
        </dd>

        <dt>{t('channels:meta.detail.subscription.lastChecked')}</dt>
        <dd>
          <Typography variant="mono" component="span">
            {checkedAt === null
              ? t('channels:meta.detail.connection.notChecked')
              : clockTime(checkedAt, locale)}
          </Typography>
        </dd>

        <dt>{t('channels:meta.detail.subscription.lastProblem')}</dt>
        <dd
          style={account.lastError === null ? undefined : { color: tokens['status.danger.text'] }}
        >
          {account.lastError === null || account.lastErrorAt === null ? (
            t('channels:meta.detail.subscription.none')
          ) : (
            <Typography
              component="span"
              variant="body2"
              dir="auto"
              sx={{ color: 'inherit', overflowWrap: 'anywhere' }}
            >
              {t('channels:meta.detail.subscription.problem', {
                time: clockTime(account.lastErrorAt, locale),
                error: account.lastError,
              })}
            </Typography>
          )}
        </dd>
      </Box>

      {status?.liveError == null || expired ? null : (
        <Typography
          variant="caption"
          role="status"
          dir="auto"
          sx={{ color: tokens['status.warning.text'] }}
        >
          {t('channels:meta.detail.subscription.unknown', { detail: status.liveError })}
        </Typography>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          disabled={subscribe.isPending}
          aria-busy={subscribe.isPending}
          startIcon={
            subscribe.isPending ? (
              <CircularProgress size={14} aria-hidden="true" />
            ) : (
              <RefreshCw size={16} aria-hidden="true" />
            )
          }
          onClick={() => {
            subscribe.mutate();
          }}
        >
          {t('channels:meta.detail.subscription.button')}
        </Button>
        <Typography variant="caption" sx={{ color: 'text.secondary', flex: '1 1 240px' }}>
          {t('channels:meta.detail.subscription.hint')}
        </Typography>
      </Box>
    </FormSection>
  );
}
