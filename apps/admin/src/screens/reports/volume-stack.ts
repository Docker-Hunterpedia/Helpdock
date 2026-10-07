/**
 * Ticket volume's stacked columns (`Admin/Reports`, M8-04): the api's sparse
 * day-by-slice cells turned into one column per day with a segment per
 * series. DESIGN §9 allows five categorical series in a chart; the sixth and
 * beyond fold into "Other".
 */

export const MAX_SERIES = 5;
export const OTHER_SERIES = 'other';

export interface StackCell {
  readonly day: string;
  readonly key: string;
  readonly count: number;
}

export interface StackSeries {
  readonly key: string;
  /** Its place in the categorical order; "Other" is always last. */
  readonly index: number;
  readonly total: number;
}

export interface VolumeStack {
  /** Largest first, then "Other" when there is one; series with nothing are left out. */
  readonly series: readonly StackSeries[];
  /** One entry per day of the range, a count per series in the order of `series`. */
  readonly days: readonly { readonly day: string; readonly counts: readonly number[] }[];
}

/**
 * `order` is the breakdown's natural order (channels, priorities or
 * statuses as the api lists them); it breaks ties between series of the
 * same size, so equal series keep a stable place.
 */
export const stackByDay = (
  days: readonly string[],
  cells: readonly StackCell[],
  order: readonly string[],
): VolumeStack => {
  const totals = new Map<string, number>();
  for (const cell of cells) {
    totals.set(cell.key, (totals.get(cell.key) ?? 0) + cell.count);
  }
  const rank = (key: string): number => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  const ranked = [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort(([a, totalA], [b, totalB]) => totalB - totalA || rank(a) - rank(b));
  const folds = ranked.length > MAX_SERIES;
  const kept = folds ? ranked.slice(0, MAX_SERIES) : ranked;
  const seriesOf = new Map(kept.map(([key], index) => [key, index]));
  const otherIndex = kept.length;

  const series: StackSeries[] = kept.map(([key, total], index) => ({ key, index, total }));
  if (folds) {
    series.push({
      key: OTHER_SERIES,
      index: otherIndex,
      total: ranked.slice(MAX_SERIES).reduce((sum, [, total]) => sum + total, 0),
    });
  }

  const byDay = new Map(days.map((day) => [day, Array<number>(series.length).fill(0)]));
  for (const cell of cells) {
    const counts = byDay.get(cell.day);
    const index = seriesOf.get(cell.key) ?? (folds ? otherIndex : undefined);
    if (counts !== undefined && index !== undefined) {
      counts[index] = (counts[index] ?? 0) + cell.count;
    }
  }

  return { series, days: days.map((day) => ({ day, counts: byDay.get(day) ?? [] })) };
};
