import type { KnowledgeSchedule } from '@helpdock/schemas';

/**
 * When a daily or weekly source next syncs, for the drawer's "next 6 Oct":
 * 03:00 in the brand's zone, Sundays for weekly — the instant BullMQ's job
 * scheduler fires for the cron of `knowledge-events.ts`. Found by walking
 * forward a quarter hour at a time in the zone, which is exact across daylight-saving
 * changes without a calendar library.
 */

const HOUR_MS = 3_600_000;
const SCHEDULE_HOUR = 3;

const localParts = (
  instant: Date,
  timeZone: string,
): { hour: number; minute: number; weekday: string } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return { hour: Number(part('hour')), minute: Number(part('minute')), weekday: part('weekday') };
};

export const nextRunAt = (
  schedule: KnowledgeSchedule,
  timeZone: string,
  now: Date,
): Date | null => {
  if (schedule !== 'daily' && schedule !== 'weekly') {
    return null;
  }
  // Every zone's offset is a whole number of quarter hours; start on the next one.
  const quarter = 15 * 60 * 1_000;
  let candidate = new Date(Math.floor(now.getTime() / quarter) * quarter + quarter);
  for (let step = 0; step < 8 * 24 * 4; step += 1) {
    const local = localParts(candidate, timeZone);
    if (
      local.hour === SCHEDULE_HOUR &&
      local.minute === 0 &&
      (schedule === 'daily' || local.weekday === 'Sun')
    ) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + quarter);
  }
  /* c8 ignore next -- every zone has a 03:00 within eight days. */
  return new Date(now.getTime() + HOUR_MS);
};
