import { z } from 'zod';
import { addDays, BACKFILL_MAX_DAYS, CHUNK_DAYS } from '../../reports/rollup-window.js';

const inputSchema = z.strictObject({
  firstDay: z.iso.date().nullable(),
  today: z.iso.date(),
  rebuildAllReports: z.boolean(),
});
export const importReportProgressSchema = z
  .strictObject({
    from: z.iso.date().nullable(),
    to: z.iso.date(),
    next: z.iso.date().nullable(),
    timezone: z.string().min(1).max(100),
    countReopens: z.boolean(),
    clipped: z.boolean(),
  })
  .refine(
    (p) =>
      (p.from === null ? p.next === null : p.from <= p.to) &&
      (p.next === null || (p.from !== null && p.next >= p.from && p.next <= p.to)),
  );

/** Backlog changes continue through today, even when the imported conversation ended years ago. */
export function importReportWindow(request: z.infer<typeof inputSchema>) {
  const { firstDay, today, rebuildAllReports } = inputSchema.parse(request);
  if (firstDay !== null && firstDay > today) throw new Error('import.future-report-date');
  const earliest = addDays(today, -(BACKFILL_MAX_DAYS - 1));
  const clipped = firstDay !== null && firstDay < earliest && !rebuildAllReports;
  return { from: clipped ? earliest : firstDay, to: today, clipped };
}

export function nextImportReportChunk(request: z.infer<typeof importReportProgressSchema>) {
  const progress = importReportProgressSchema.parse(request);
  if (progress.next === null) return null;
  const end = addDays(progress.next, CHUNK_DAYS - 1);
  const to = end < progress.to ? end : progress.to;
  return { range: { from: progress.next, to }, next: to === progress.to ? null : addDays(to, 1) };
}
