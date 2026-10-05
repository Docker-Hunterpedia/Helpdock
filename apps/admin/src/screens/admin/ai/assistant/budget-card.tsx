import type { BrandAiSettings } from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { Switch } from '../../../../ui/switch.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { meterTone, UsageMeter } from '../../../../ui/usage-meter.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { failureMessage, percentOf, usd } from '../format.js';
import { settingsUpdateOf } from '../settings-update.js';

/**
 * The Budget card of `Admin/AI-Assistant` (M7-08): today's and this month's
 * spend as UsageMeters, the two limits, and what happens at the hard stop —
 * including whether agent assist stays on, which is one of the modes.
 */

/** A limit as typed: empty for none, otherwise a positive amount. */
export const limitOf = (typed: string): number | null | 'invalid' => {
  if (typed.trim() === '') {
    return null;
  }
  const amount = Number(typed);
  return Number.isFinite(amount) && amount > 0 && amount <= 1_000_000 ? amount : 'invalid';
};

/** The meter's tone as the caption's level: the alert at 80 %, the hard stop at 100 %. */
const LEVEL_BY_TONE = { normal: 'ok', warning: 'warning', danger: 'exceeded' } as const;

const typedOf = (amount: number | null): string => (amount === null ? '' : amount.toFixed(2));

export function BudgetCard({
  brandId,
  settings,
  canManage,
  limitInputId,
}: {
  readonly brandId: string;
  readonly settings: BrandAiSettings;
  readonly canManage: boolean;
  /** Prefix of the two limit inputs' ids, which the banner's "Raise limit" focuses. */
  readonly limitInputId: string;
}): ReactNode {
  const t = useT();
  const api = useAiApi();
  const toast = useToast();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const [daily, setDaily] = useState(typedOf(settings.budget.dailyUsd));
  const [monthly, setMonthly] = useState(typedOf(settings.budget.monthlyUsd));
  const [keepAssist, setKeepAssist] = useState(settings.modes.keepAssistAfterHardStop);
  const [invalid, setInvalid] = useState<{ day: boolean; month: boolean }>({
    day: false,
    month: false,
  });

  useEffect(() => {
    setDaily(typedOf(settings.budget.dailyUsd));
    setMonthly(typedOf(settings.budget.monthlyUsd));
    setKeepAssist(settings.modes.keepAssistAfterHardStop);
  }, [settings]);

  const save = useMutation({
    mutationFn: async (budget: BrandAiSettings['budget']): Promise<BrandAiSettings> => {
      let saved = await api.saveBrandSettings(brandId, { ...settingsUpdateOf(settings), budget });
      if (keepAssist !== settings.modes.keepAssistAfterHardStop) {
        saved = await api.saveModes(brandId, {
          ...saved.modes,
          keepAssistAfterHardStop: keepAssist,
          aiCountsAsFirstResponse: saved.aiCountsAsFirstResponse,
        });
      }
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(aiKeys.brand(brandId), saved);
      toast({ tone: 'success', message: t('aiSettings:budget.saved') });
    },
    onError: (error: unknown) => {
      toast({ tone: 'danger', message: failureMessage(t, error) });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const day = limitOf(daily);
    const month = limitOf(monthly);
    setInvalid({ day: day === 'invalid', month: month === 'invalid' });
    if (day !== 'invalid' && month !== 'invalid') {
      save.mutate({ dailyUsd: day, monthlyUsd: month });
    }
  };

  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(),
  );
  const meter = (period: 'day' | 'month', spent: number, limit: number | null) => {
    const percent = limit === null ? 0 : percentOf(spent, limit);
    const level = LEVEL_BY_TONE[meterTone(percent)];
    const label = period === 'day' ? t('aiSettings:budget.today') : monthName;
    return (
      <UsageMeter
        label={label}
        figure={
          limit === null
            ? t('aiSettings:budget.noLimitFigure', { spent: usd(spent) })
            : `${usd(spent)} ${t('aiSettings:budget.of', { limit: usd(limit) })}`
        }
        percent={percent}
        caption={
          limit === null
            ? t('aiSettings:budget.noLimit')
            : t(`aiSettings:budget.meterCaption.${level}`, { percent })
        }
        accessibleLabel={t(`aiSettings:budget.progress.${period}`, { percent })}
      />
    );
  };

  const limitField = (period: 'day' | 'month', value: string, set: (value: string) => void) => {
    const inputId = `${limitInputId}-${period}`;
    const error = invalid[period] ? t('aiSettings:budget.invalid') : undefined;
    const hint = t('aiSettings:budget.limitHint');
    return (
      <Field id={inputId} label={t(`aiSettings:budget.limit.${period}`)} hint={hint} error={error}>
        <TextField
          id={inputId}
          size="small"
          value={value}
          disabled={!canManage}
          error={error !== undefined}
          onChange={(event) => {
            set(event.target.value);
          }}
          slotProps={{
            htmlInput: {
              dir: 'ltr',
              inputMode: 'decimal',
              'aria-describedby': fieldDescribedBy(inputId, { hint, error }),
            },
          }}
        />
      </Field>
    );
  };

  return (
    <SectionCard
      id={`${limitInputId}-budget`}
      heading={t('aiSettings:budget.heading')}
      caption={t('aiSettings:budget.caption')}
      onSubmit={submit}
      footer={
        canManage ? (
          <>
            <Button
              variant="text"
              disabled={save.isPending}
              onClick={() => {
                setDaily(typedOf(settings.budget.dailyUsd));
                setMonthly(typedOf(settings.budget.monthlyUsd));
                setKeepAssist(settings.modes.keepAssistAfterHardStop);
                setInvalid({ day: false, month: false });
              }}
            >
              {t('aiSettings:discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {t('aiSettings:budget.save')}
            </Button>
          </>
        ) : (
          <Typography variant="caption" sx={{ color: 'text.secondary', marginInlineEnd: 'auto' }}>
            {t('aiSettings:adminOnly')}
          </Typography>
        )
      }
    >
      {meter('day', settings.usage.todayUsd, settings.budget.dailyUsd)}
      {meter('month', settings.usage.monthUsd, settings.budget.monthlyUsd)}

      <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 3 }}>
        {limitField('day', daily, setDaily)}
        {limitField('month', monthly, setMonthly)}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('aiSettings:budget.alertNote')}
      </Typography>

      <Box
        sx={{
          padding: 3,
          borderRadius: '6px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.canvas'],
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
          {t('aiSettings:budget.hardStop')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:budget.hardStopBody')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Switch
            checked={keepAssist}
            label={t('aiSettings:budget.keepAssist')}
            disabled={!canManage}
            onChange={setKeepAssist}
          />
          <Typography variant="body2" aria-hidden="true">
            {t('aiSettings:budget.keepAssist')}
          </Typography>
        </Box>
      </Box>
    </SectionCard>
  );
}
