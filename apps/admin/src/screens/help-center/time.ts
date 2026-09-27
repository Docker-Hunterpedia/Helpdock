import type { Locale } from '@helpdock/i18n';

/**
 * Times on the help center screens are the **brand's**: a scheduled publish at
 * "1 Oct 09:00" means nine in the morning where the brand is (the artboard's
 * "Asia/Riyadh, the brand timezone"), whoever is reading. Latin digits in both
 * locales (DESIGN §7).
 */

const monthName = (at: Date, locale: Locale, timeZone: string): string =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-US', { month: 'short', timeZone }).format(
    at,
  );

/** "12 Sep" in the brand's time zone. */
export const formatDay = (iso: string, locale: Locale, timeZone: string): string => {
  const at = new Date(iso);
  return `${Number(parts(at, timeZone).day)} ${monthName(at, locale, timeZone)}`;
};

/** "12 Sep 10:02" in the brand's time zone. */
export const formatStamp = (iso: string, locale: Locale, timeZone: string): string => {
  const { time } = toWallClock(iso, timeZone);
  return `${formatDay(iso, locale, timeZone)} ${time}`;
};

interface WallClock {
  readonly date: string;
  readonly time: string;
}

const parts = (at: Date, timeZone: string): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone,
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );

/** The date and time an instant reads as in the zone, for the Date and Time inputs. */
export const toWallClock = (iso: string, timeZone: string): WallClock => {
  const p = parts(new Date(iso), timeZone);
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
};

/**
 * The instant a wall-clock date and time in the zone names, or null for an
 * input that is not a date and time. Found by measuring the zone's offset at
 * the guess and correcting once, which is exact everywhere but inside the hour
 * a clock skips.
 */
export const fromWallClock = ({ date, time }: WallClock, timeZone: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (match === null || clock === null) {
    return null;
  }
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const [, hh, mm] = clock.map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) {
    return null;
  }
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (instant: number): number => {
    const p = parts(new Date(instant), timeZone);
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour === '24' ? '0' : p.hour),
      Number(p.minute),
      Number(p.second),
    );
    return asUtc - instant;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first)).toISOString();
};
