import type { TelegramBot, TelegramTestResult } from '@helpdock/schemas';
import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { CircleCheck, PlugZap, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession } from '../../../../auth/session.tsx';
import { useTelegramApi } from '../../../../telegram/context.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { clockTime, shortDate } from '../format.js';
import { FormSection } from './form-section.tsx';

/**
 * Connection: the saved token as its last four characters and Replace, which
 * opens an empty field the save sends; and Test connection, `getMe` with the
 * saved token, answered in place with what Telegram said.
 */
export function ConnectionSection({
  bot,
  token,
  tokenError,
  onTokenChange,
}: {
  readonly bot: TelegramBot;
  /** Null while the saved token is kept. */
  readonly token: string | null;
  readonly tokenError: string | undefined;
  onTokenChange(token: string | null): void;
}): ReactNode {
  const t = useT();
  const api = useTelegramApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const { locale } = usePreferences();
  const id = useId();
  const [result, setResult] = useState<{ at: string; outcome: TelegramTestResult } | null>(null);

  const test = useMutation({
    mutationFn: () => api.testBot(brand.id, bot.id),
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

  const date = shortDate(bot.tokenUpdatedAt, locale);
  const hint =
    token !== null
      ? undefined
      : bot.tokenUpdatedByName === null
        ? t('channels:telegram.detail.connection.savedBySomeone', { date })
        : t('channels:telegram.detail.connection.saved', { date, name: bot.tokenUpdatedByName });

  return (
    <FormSection
      heading={t('channels:telegram.detail.connection.heading')}
      caption={t('channels:telegram.detail.connection.caption')}
    >
      <Field
        id={id}
        label={t('channels:telegram.detail.connection.token')}
        hint={hint}
        error={tokenError}
      >
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={id}
            size="small"
            type={token === null ? 'text' : 'password'}
            autoComplete="off"
            value={token ?? `•••• ${bot.tokenHint}`}
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
                      'aria-label': t('channels:telegram.detail.connection.masked', {
                        hint: bot.tokenHint,
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
              {t('channels:telegram.detail.connection.replace')}
            </Button>
          ) : null}
        </Box>
      </Field>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
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
          {t('channels:telegram.detail.connection.test')}
        </Button>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('channels:telegram.detail.connection.testHint')}
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
  readonly outcome: TelegramTestResult;
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
            ? t('channels:telegram.detail.connection.connected', { time })
            : outcome.kind === 'connect'
              ? t('channels:telegram.detail.connection.unreachable', { time })
              : t('channels:telegram.detail.connection.refused', { time })}
        </Typography>
        <Typography
          component="span"
          sx={{ fontSize: 13, color: 'inherit', overflowWrap: 'anywhere' }}
        >
          {outcome.ok ? (
            <bdi>
              {t('channels:telegram.detail.connection.connectedBody', {
                username: outcome.username,
                name: outcome.name,
                id: outcome.telegramId,
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
