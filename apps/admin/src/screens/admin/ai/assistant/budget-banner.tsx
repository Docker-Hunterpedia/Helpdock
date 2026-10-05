import type { BrandAiSettings } from '@helpdock/schemas';
import { Button } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { dayOf, nextWindow, percentOf, usd } from '../format.js';

/**
 * The banner over the Assistant tab while a budget window is at its alert or
 * past its hard stop (M7-08). A hard stop says when auto-reply returns and
 * whether agent assist stayed on, and offers "Raise limit", which takes the
 * Admin to the field that lifts it.
 */
export function BudgetBanner({
  settings,
  canRaise,
  limitInputId,
}: {
  readonly settings: BrandAiSettings;
  readonly canRaise: boolean;
  /** The limit field "Raise limit" moves focus to. */
  readonly limitInputId: string;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const windows = settings.usage.windows;
  const exceeded =
    windows.find((window) => window.period === 'month' && window.level === 'exceeded') ??
    windows.find((window) => window.level === 'exceeded');
  const warning = windows.find((window) => window.level === 'warning');

  if (exceeded !== undefined) {
    const until = dayOf(nextWindow(exceeded.period, new Date()), locale);
    return (
      <AlertBanner tone="danger">
        <strong>{t('aiSettings:budgetBanner.exceededTitle', { date: until })}</strong>{' '}
        {t(
          settings.modes.keepAssistAfterHardStop
            ? 'aiSettings:budgetBanner.exceededAssistOn'
            : 'aiSettings:budgetBanner.exceededAssistOff',
          { limit: usd(exceeded.limitUsd), period: t(`aiSettings:period.${exceeded.period}`) },
        )}
        {canRaise ? (
          <>
            {' '}
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                document.getElementById(`${limitInputId}-${exceeded.period}`)?.focus();
              }}
            >
              {t('aiSettings:budgetBanner.raise')}
            </Button>
          </>
        ) : null}
      </AlertBanner>
    );
  }

  if (warning !== undefined) {
    return (
      <AlertBanner tone="warning">
        <strong>
          {t('aiSettings:budgetBanner.warningTitle', {
            percent: percentOf(warning.spentUsd, warning.limitUsd),
            period: t(`aiSettings:period.${warning.period}`),
          })}
        </strong>{' '}
        {t('aiSettings:budgetBanner.warningBody', {
          spent: usd(warning.spentUsd),
          limit: usd(warning.limitUsd),
        })}
      </AlertBanner>
    );
  }

  return null;
}
