import type { ReportSummary } from '@helpdock/schemas';
import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { MetricTile } from '../../ui/metric-tile.js';
import { formatCount } from '../admin/system/format.js';
import { type Direction, directionOf, relativeChange, slaTotals } from './kpis.js';
import { formatAverage, formatDuration } from './report-format.js';

/**
 * The four MetricTiles at the top of `Admin/Reports` (M8-04), each compared
 * in words with the same number of days just before the range. The previous
 * period is a second read of the same route; until it arrives, or when it had
 * nothing to compare with, the caption explains the figure instead.
 */
export function KpiTiles({
  current,
  previous,
  days,
}: {
  readonly current: ReportSummary;
  readonly previous: ReportSummary | undefined;
  readonly days: number;
}): ReactNode {
  const t = useT();

  const created = current.volume.created;
  const createdChange =
    previous === undefined ? null : relativeChange(created, previous.volume.created);

  const median = current.firstResponse.medianMs;
  const previousMedian = previous?.firstResponse.medianMs ?? null;

  const sla = slaTotals(current.sla).compliance;
  const previousSla = previous === undefined ? null : slaTotals(previous.sla).compliance;

  const csat = current.csat.average;
  const previousCsat = previous?.csat.average ?? null;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'repeat(2, minmax(0, 1fr))',
          lg: 'repeat(4, minmax(0, 1fr))',
        },
        gap: 3,
      }}
    >
      <MetricTile
        label={t('reports:kpi.created.label')}
        figure={formatCount(created)}
        caption={
          createdChange === null
            ? t('reports:kpi.created.inDays', { count: days })
            : t(`reports:kpi.created.${directionOf(createdChange)}`, {
                percent: Math.round(Math.abs(createdChange) * 100),
                count: days,
              })
        }
      />
      <MetricTile
        label={t('reports:kpi.firstResponse.label')}
        figure={median === null ? '—' : formatDuration(median)}
        caption={
          median === null || previousMedian === null
            ? t('reports:kpi.firstResponse.over', { count: current.firstResponse.count })
            : t(`reports:kpi.firstResponse.${speed(median - previousMedian)}`, {
                amount: formatDuration(Math.abs(median - previousMedian)),
                count: days,
              })
        }
      />
      <MetricTile
        label={t('reports:kpi.sla.label')}
        figure={sla === null ? '—' : `${(sla * 100).toFixed(1)} %`}
        caption={
          sla === null || previousSla === null
            ? t('reports:kpi.sla.none')
            : t(`reports:kpi.sla.${directionOf(sla - previousSla)}`, {
                points: Math.abs((sla - previousSla) * 100).toFixed(1),
                count: days,
              })
        }
      />
      <MetricTile
        label={t('reports:kpi.csat.label')}
        figure={csat === null ? '—' : `${formatAverage(csat)} / 5`}
        caption={
          csat === null || previousCsat === null
            ? t('reports:kpi.csat.answers', { count: current.csat.responses })
            : t(`reports:kpi.csat.${directionOf(csat - previousCsat, 0.05)}`, {
                answers: formatCount(current.csat.responses),
                amount: Math.abs(csat - previousCsat).toFixed(1),
                count: days,
              })
        }
      />
    </Box>
  );
}

/** A median that went up is slower; under a minute either way is unchanged. */
const speed = (deltaMs: number): 'slower' | 'faster' | 'same' => {
  const direction: Direction = directionOf(deltaMs, 60_000);
  if (direction === 'same') {
    return 'same';
  }
  return direction === 'up' ? 'slower' : 'faster';
};
