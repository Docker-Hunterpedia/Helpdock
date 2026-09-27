import type { Locale } from '@helpdock/i18n';
import { usePreferences } from '../../../app/providers.tsx';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a rule last ran, as the list and the log print it: `14:02` today, and
 * `19 Sep 14:02` before that. Latin digits in both locales (DESIGN §7).
 */
export const timeOfDay = (iso: string, locale: Locale, now: number): string => {
  const at = new Date(iso);
  const sameDay = now - at.getTime() < DAY_MS && new Date(now).getDate() === at.getDate();

  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : locale, {
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
};

export function useTimeOfDay(): (iso: string) => string {
  const { locale } = usePreferences();
  return (iso) => timeOfDay(iso, locale, Date.now());
}
