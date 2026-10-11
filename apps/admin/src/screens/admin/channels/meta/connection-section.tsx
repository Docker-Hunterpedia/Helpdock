import type { MetaAccount, MetaAccountStatusResponse, MetaTestResult } from '@helpdock/schemas';
import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, PlugZap, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { useMetaApi } from '../../../../meta/context.tsx';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { clockTime, shortDate } from '../format.js';
import { FormSection } from '../telegram/form-section.tsx';
import { accountLabel } from './platforms.js';

/**
 * Connection (M10-07, `Admin/Channels-Meta-Account`): the saved token as its
 * last four characters and Replace, which opens an empty field the save sends;
 * what kind of token it is and when it ends; and Test connection, a read with
 * the saved token, answered in place with what Meta said. When Meta has
 * invalidated the token the section opens with what Meta said and Reconnect.
 */
export function ConnectionSection({
  account,
  status,
  token,
  tokenError,
  onTokenChange,
  onReconnect,
}: {
  readonly account: MetaAccount;
  /** Undefined while Meta is being asked. */
  readonly status: MetaAccountStatusResponse | undefined;
  /** Null while the saved token is kept. */
  readonly token: string | null;
  readonly tokenError: string | undefined;
  onTokenChange(token: string | null): void;
  onReconnect(): void;
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const id = useId();
  const [result, setResult] = useState<{ at: string; outcome: MetaTestResult } | null>(null);

  const test = useMutation({
    mutationFn: () => api.testAccount(brand.id, account.id),
    onMutate: () => {
      setResult(null);
    },
    onSuccess: (outcome) => {
      setResult({ at: new Date().toISOString(), outcome });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const date = shortDate(account.tokenUpdatedAt, locale);
  const hint =
    token !== null
      ? undefined
      : account.tokenUpdatedByName === null
        ? t('channels:meta.detail.connection.savedBySomeone', { date })
        : t('channels:meta.detail.connection.saved', { date, name: account.tokenUpdatedByName });
  const expired = account.status === 'token_expired';
  const checkedAt = status?.subscriptionCheckedAt ?? null;

  return (
    <FormSection
      heading={t('channels:meta.detail.connection.heading')}
      caption={t(`channels:meta.detail.connection.caption.${account.platform}`)}
    >
      {expired ? (
        <AlertBanner tone="danger">
          <strong>
            {t('channels:meta.detail.connection.expiredLead', { name: accountLabel(account) })}
          </strong>{' '}
          {t('channels:meta.detail.connection.expiredBody')}
          {account.lastError === null ? null : (
            <>
              {' '}
              <span dir="auto">
                {t('channels:meta.health.metaSaid', { error: account.lastError })}
              </span>
            </>
          )}
        </AlertBanner>
      ) : null}

      <Field
        id={id}
        label={t('channels:meta.detail.connection.token')}
        hint={hint}
        error={tokenError}
      >
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={id}
            size="small"
            type={token === null ? 'text' : 'password'}
            autoComplete="off"
            value={token ?? `•••• ${account.tokenHint}`}
            error={tokenError !== undefined}
            fullWidth
            onChange={(event) => {
              onTokenChange(event.target.value);
            }}
            slotProps={{
              htmlInput: {
                readOnly: token === null,
                dir: 'ltr',
                spellCheck: false,
                'aria-describedby': fieldDescribedBy(id, { hint, error: tokenError }),
                'aria-invalid': tokenError !== undefined,
                ...(token === null
                  ? {
                      'aria-label': t('channels:meta.detail.connection.masked', {
                        hint: account.tokenHint,
                      }),
                    }
                  : {}),
              },
            }}
            sx={{ '& input': (theme) => ({ ...theme.typography.mono, fontSize: 13 }) }}
          />
          {token === null ? (
            <Button
              variant="outlined"
              onClick={() => {
                onTokenChange('');
              }}
            >
              {t('channels:meta.detail.connection.replace')}
            </Button>
          ) : null}
        </Box>
      </Field>

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
        <dt>{t('channels:meta.detail.connection.kind')}</dt>
        <dd>{t(`channels:meta.detail.connection.kinds.${account.tokenKind}`)}</dd>
        <dt>{t('channels:meta.detail.connection.expires')}</dt>
        <dd style={expired ? { color: tokens['status.danger.text'] } : undefined}>
          {expired && account.lastErrorAt !== null
            ? t('channels:meta.detail.connection.invalidated', {
                date: `${shortDate(account.lastErrorAt, locale)}, ${clockTime(account.lastErrorAt, locale)}`,
              })
            : account.tokenExpiresAt === null
              ? t('channels:meta.detail.connection.never')
              : shortDate(account.tokenExpiresAt, locale)}
        </dd>
        <dt>{t('channels:meta.detail.connection.lastChecked')}</dt>
        <dd>
          <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
            {checkedAt === null
              ? t('channels:meta.detail.connection.notChecked')
              : clockTime(checkedAt, locale)}
          </Typography>
        </dd>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        {expired ? (
          <Button variant="contained" aria-haspopup="dialog" onClick={onReconnect}>
            {t('channels:meta.detail.connection.reconnect')}
          </Button>
        ) : null}
        <Button
          variant="outlined"
          disabled={test.isPending}
          aria-busy={test.isPending}
          startIcon={
            test.isPending ? (
              <CircularProgress size={14} aria-hidden="true" />
            ) : (
              <PlugZap size={16} aria-hidden="true" />
            )
          }
          onClick={() => {
            test.mutate();
          }}
        >
          {t('channels:meta.detail.connection.test')}
        </Button>
        <Typography variant="caption" sx={{ color: 'text.secondary', flex: '1 1 240px' }}>
          {expired
            ? t('channels:meta.detail.connection.reconnectHint')
            : t(`channels:meta.detail.connection.testHint.${account.platform}`)}
        </Typography>
      </Box>

      {result === null ? null : <TestOutcome at={result.at} outcome={result.outcome} />}
    </FormSection>
  );
}

function TestOutcome({
  at,
  outcome,
}: {
  readonly at: string;
  readonly outcome: MetaTestResult;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const tone = outcome.ok ? 'success' : 'danger';
  const Icon = outcome.ok ? CircleCheck : TriangleAlert;
  const time = clockTime(at, locale);

  return (
    <Box
      role={outcome.ok ? 'status' : 'alert'}
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        paddingBlock: '10px',
        paddingInline: 3,
        borderRadius: '6px',
        backgroundColor: tokens[`status.${tone}.tint`],
        border: `1px solid ${tokens[`status.${tone}`]}`,
        color: tokens[`status.${tone}.text`],
        fontSize: 13,
        lineHeight: '18px',
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 1 }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <Typography component="span" sx={{ fontWeight: 500, fontSize: 13, color: 'inherit' }}>
          {outcome.ok
            ? t('channels:meta.detail.connection.connected', { time })
            : outcome.kind === 'connect'
              ? t('channels:meta.detail.connection.unreachable', { time })
              : t('channels:meta.detail.connection.refused', { time })}
        </Typography>
        <Typography
          component="span"
          dir="auto"
          sx={{ fontSize: 13, color: 'inherit', overflowWrap: 'anywhere' }}
        >
          {outcome.ok ? (
            <bdi>
              {t('channels:meta.detail.connection.connectedBody', {
                name:
                  outcome.username === undefined
                    ? outcome.name
                    : `${outcome.name} (@${outcome.username})`,
                id: outcome.externalId,
              })}
            </bdi>
          ) : (
            (outcome.detail ?? '')
          )}
        </Typography>
      </Box>
    </Box>
  );
}
