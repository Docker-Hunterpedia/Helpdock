const DAY_MS = 86_400_000;

/** DESIGN §6.3 PendingDeletionRow: the countdown turns to a warning in the last days. */
export const LAST_DAYS = 3;

/** Whole days until the purge, rounded up so "less than a day" still reads as 1; never negative. */
export const daysLeft = (purgeAfter: string, now: number = Date.now()): number =>
  Math.max(0, Math.ceil((Date.parse(purgeAfter) - now) / DAY_MS));

export const isLastDays = (days: number): boolean => days <= LAST_DAYS;
