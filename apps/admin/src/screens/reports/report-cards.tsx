import {
  type ReportExport,
  type ReportSummary,
  type SlaOutcome,
  type TicketChannel,
  type TicketPriority,
  ticketChannelSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { Box, Link, Typography } from '@mui/material';
import { type ReactNode, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { helpCenterRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { formatDayMonth, formatShare } from '../../ui/format.js';
import { formatCount, formatUsd } from '../admin/system/format.js';
import { ChartCard } from './chart-card.js';
import {
  Heatmap,
  LineChart,
  SERIES_PRIMARY,
  SERIES_SECONDARY,
  type ShareRow,
  ShareRows,
  StackedColumnChart,
  seriesColour,
} from './charts.js';
import { DataTable, type Row } from './data-table.js';
import { HOURS, heatmapGrid, WEEKDAYS } from './heatmap-scale.js';
import { csatShares, slaTotals } from './kpis.js';
import { formatAverage, formatDuration } from './report-format.js';
import { OTHER_SERIES, type StackCell, stackByDay } from './volume-stack.js';

/**
 * Every card of `Admin/Reports` (M8-04) but the KPI tiles, each drawn from
 * `GET /api/brands/:brandId/reports` and exporting its rows through the CSV
 * route. Where the artboard draws something the summary does not carry the
 * card draws what the api has and the milestone doc lists the difference.
 */

export interface CardProps {
  readonly summary: ReportSummary;
  /** Downloads one report's CSV with the filters in force. */
  readonly onExport: (report: ReportExport) => void;
  /** The export in flight, if any. */
  readonly exporting: ReportExport | null;
}

const exportProps = (props: CardProps, report: ReportExport) => ({
  onExport: () => {
    props.onExport(report);
  },
  exporting: props.exporting === report,
});

const useDayLabel = (): ((day: string) => string) => {
  const { locale } = usePreferences();
  return (day) => formatDayMonth(day, locale, 'UTC');
};

type VolumeBreakdown = 'channel' | 'status' | 'priority';

const VOLUME_EXPORT: Record<VolumeBreakdown, ReportExport> = {
  channel: 'volume',
  priority: 'volume',
  status: 'volume_by_status',
};

/** The day-by-slice cells and the names of one breakdown, in the api's order. */
const useVolumeSlices = (
  volume: ReportSummary['volume'],
  breakdown: VolumeBreakdown,
): { cells: StackCell[]; order: string[]; labelOf: (key: string) => string } => {
  const t = useT();
  if (breakdown === 'channel') {
    return {
      cells: volume.byDayAndChannel.map((c) => ({ day: c.day, key: c.channel, count: c.created })),
      order: [...ticketChannelSchema.options],
      labelOf: (key) => t(`tickets:channel.${key as TicketChannel}`),
    };
  }
  if (breakdown === 'priority') {
    return {
      cells: volume.byDayAndPriority.map((c) => ({
        day: c.day,
        key: c.priority,
        count: c.created,
      })),
      order: [...ticketPrioritySchema.options].reverse(),
      labelOf: (key) => t(`tickets:priority.${key as TicketPriority}`),
    };
  }
  const names = new Map(volume.byStatus.map((row) => [row.statusId, row.name]));
  return {
    cells: volume.byDayAndStatus.map((c) => ({ day: c.day, key: c.statusId, count: c.tickets })),
    order: volume.byStatus.map((row) => row.statusId),
    labelOf: (key) => names.get(key) ?? key,
  };
};

export function VolumeCard(props: CardProps): ReactNode {
  const t = useT();
  const dayLabel = useDayLabel();
  const [breakdown, setBreakdown] = useState<VolumeBreakdown>('channel');
  const { volume } = props.summary;
  const days = volume.byDay;
  const title = t('reports:volume.title');
  const slices = useVolumeSlices(volume, breakdown);
  const stack = stackByDay(
    days.map((day) => day.day),
    slices.cells,
    slices.order,
  );
  const series = stack.series.map((entry) => ({
    key: entry.key,
    label: entry.key === OTHER_SERIES ? t('reports:volume.other') : slices.labelOf(entry.key),
    colour: seriesColour(entry.index),
    total: entry.total,
  }));
  const total = series.reduce((sum, entry) => sum + entry.total, 0);
  const shares: ShareRow[] = series.map((entry) => ({
    key: entry.key,
    label: entry.label,
    share: entry.total / Math.max(1, total),
    value: formatCount(entry.total),
    colour: entry.colour,
  }));
  const breakdownLabel = t(`reports:volume.by.${breakdown}`);

  return (
    <ChartCard<VolumeBreakdown>
      wide
      title={title}
      caption={t('reports:volume.caption', { count: volume.created, days: days.length })}
      breakdown={{
        label: t('reports:volume.breakdown'),
        value: breakdown,
        options: (['channel', 'status', 'priority'] as const).map((value) => ({
          value,
          label: t(`reports:volume.by.${value}`),
        })),
        onChange: setBreakdown,
      }}
      legend={series.map((entry) => ({ label: entry.label, colour: entry.colour }))}
      onExport={() => {
        props.onExport(VOLUME_EXPORT[breakdown]);
      }}
      exporting={props.exporting === VOLUME_EXPORT[breakdown]}
      chart={
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 260px' },
            gap: 4,
            alignItems: 'start',
          }}
        >
          <StackedColumnChart
            label={t('reports:volume.chartLabel', {
              created: volume.created,
              resolved: volume.resolved,
              days: days.length,
              breakdown: breakdownLabel,
              figures: shares.map((row) => `${row.label} ${row.value}`).join(', '),
            })}
            dayLabels={days.map((day) => dayLabel(day.day))}
            series={series}
            counts={stack.days.map((day) => day.counts)}
            tooltipTitleOf={(index) =>
              t('reports:volume.tooltip', {
                day: dayLabel(days[index]?.day ?? ''),
                count: (stack.days[index]?.counts ?? []).reduce((sum, value) => sum + value, 0),
              })
            }
          />
          <Box sx={{ display: 'grid', gap: 2 }}>
            <Typography variant="caption" component="h3" sx={{ margin: 0 }}>
              {breakdownLabel}
            </Typography>
            <ShareRows
              label={t('reports:volume.breakdownLabel', {
                breakdown: breakdownLabel,
                figures: shares.map((row) => `${row.label} ${row.value}`).join(', '),
              })}
              rows={shares}
            />
            <Typography variant="mono" component="p" sx={{ fontSize: 12, textAlign: 'end' }}>
              {t('reports:volume.total', { count: formatCount(total) })}
            </Typography>
          </Box>
        </Box>
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'day', label: t('reports:columns.day') },
            ...series.map((entry) => ({
              key: `s:${entry.key}`,
              label: entry.label,
              numeric: true,
            })),
            { key: 'created', label: t('reports:columns.created'), numeric: true },
            { key: 'resolved', label: t('reports:columns.resolved'), numeric: true },
          ]}
          rows={days.map((day, index) => ({
            id: day.day,
            day: dayLabel(day.day),
            ...Object.fromEntries(
              series.map((entry, segment) => [
                `s:${entry.key}`,
                formatCount(stack.days[index]?.counts[segment] ?? 0),
              ]),
            ),
            created: formatCount(day.created),
            resolved: formatCount(day.resolved),
          }))}
        />
      }
    />
  );
}

export function ResponseTimesCard(props: CardProps): ReactNode {
  const t = useT();
  const { firstResponse, resolution } = props.summary;
  const title = t('reports:times.title');
  const metrics = [
    { key: 'firstResponse', label: t('reports:times.firstResponse'), stats: firstResponse },
    { key: 'resolution', label: t('reports:times.resolution'), stats: resolution },
  ] as const;
  const durationOf = (ms: number | null): string => (ms === null ? '—' : formatDuration(ms));

  return (
    <ChartCard
      title={title}
      caption={t('reports:times.caption')}
      legend={[
        { label: t('reports:times.median'), colour: SERIES_PRIMARY },
        { label: t('reports:times.p90'), colour: SERIES_SECONDARY },
      ]}
      {...exportProps(props, 'response_times')}
      chart={
        <Box sx={{ display: 'grid', gap: 4 }}>
          {metrics.map((metric) => {
            const scale = Math.max(1, metric.stats.p90Ms ?? 0, metric.stats.medianMs ?? 0);
            return (
              <Box key={metric.key} sx={{ display: 'grid', gap: 2 }}>
                <Typography variant="caption" component="h3" sx={{ margin: 0 }}>
                  {t('reports:times.over', { metric: metric.label, count: metric.stats.count })}
                </Typography>
                <ShareRows
                  label={t('reports:times.chartLabel', {
                    metric: metric.label,
                    median: durationOf(metric.stats.medianMs),
                    p90: durationOf(metric.stats.p90Ms),
                  })}
                  rows={[
                    {
                      key: 'median',
                      label: t('reports:times.median'),
                      share: (metric.stats.medianMs ?? 0) / scale,
                      value: durationOf(metric.stats.medianMs),
                      colour: SERIES_PRIMARY,
                    },
                    {
                      key: 'p90',
                      label: t('reports:times.p90'),
                      share: (metric.stats.p90Ms ?? 0) / scale,
                      value: durationOf(metric.stats.p90Ms),
                      colour: SERIES_SECONDARY,
                    },
                  ]}
                />
              </Box>
            );
          })}
        </Box>
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'metric', label: t('reports:columns.metric') },
            { key: 'count', label: t('reports:columns.count'), numeric: true },
            { key: 'median', label: t('reports:times.median'), numeric: true },
            { key: 'p90', label: t('reports:times.p90'), numeric: true },
          ]}
          rows={metrics.map((metric) => ({
            id: metric.key,
            metric: metric.label,
            count: formatCount(metric.stats.count),
            median: durationOf(metric.stats.medianMs),
            p90: durationOf(metric.stats.p90Ms),
          }))}
        />
      }
    />
  );
}

export function SlaCard(props: CardProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { sla } = props.summary;
  const totals = slaTotals(sla);
  const title = t('reports:sla.title');
  const clocks = [
    { key: 'response', label: t('reports:sla.response'), outcome: sla.response },
    { key: 'resolution', label: t('reports:sla.resolution'), outcome: sla.resolution },
  ] as const;
  const priorities = sla.byPriority.map((row) => ({
    key: row.priority,
    label: t(`tickets:priority.${row.priority}`),
    outcome: row,
  }));
  const shareRow = (entry: {
    readonly key: string;
    readonly label: string;
    readonly outcome: SlaOutcome;
  }): ShareRow => ({
    key: entry.key,
    label: entry.label,
    share: entry.outcome.compliance ?? 0,
    value: entry.outcome.compliance === null ? '—' : formatShare(entry.outcome.compliance),
    of: t('reports:of', { count: entry.outcome.met + entry.outcome.breached }),
    colour: tokens['status.success'],
  });
  const rows = clocks.map(shareRow);
  const priorityRows = priorities.map(shareRow);
  const figuresOf = (shareRows: readonly ShareRow[]): string =>
    shareRows.map((row) => `${row.label} ${row.value} ${row.of ?? ''}`).join(', ');
  const tableRow = (entry: (typeof clocks)[number] | (typeof priorities)[number]) => ({
    id: entry.key,
    clock: entry.label,
    met: formatCount(entry.outcome.met),
    breached: formatCount(entry.outcome.breached),
    compliance: entry.outcome.compliance === null ? '—' : formatShare(entry.outcome.compliance),
  });

  return (
    <ChartCard
      title={title}
      caption={t('reports:sla.caption')}
      headline={{
        figure: totals.compliance === null ? '—' : formatShare(totals.compliance),
        sentence: t('reports:sla.sentence', {
          met: formatCount(totals.met),
          total: formatCount(totals.met + totals.breached),
          breached: formatCount(totals.breached),
        }),
      }}
      {...exportProps(props, 'sla')}
      chart={
        <Box sx={{ display: 'grid', gap: 2 }}>
          {priorityRows.length === 0 ? null : (
            <>
              <Typography variant="caption" component="h3" sx={{ margin: 0 }}>
                {t('reports:sla.byPriority')}
              </Typography>
              <ShareRows
                label={t('reports:sla.priorityChartLabel', { figures: figuresOf(priorityRows) })}
                rows={priorityRows}
              />
            </>
          )}
          <Typography variant="caption" component="h3" sx={{ margin: 0 }}>
            {t('reports:sla.byClock')}
          </Typography>
          <ShareRows
            label={t('reports:sla.chartLabel', { figures: figuresOf(rows) })}
            rows={rows}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {sla.countsReopens ? t('reports:sla.countsReopens') : t('reports:sla.ignoresReopens')}
          </Typography>
        </Box>
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'clock', label: t('reports:columns.slice') },
            { key: 'met', label: t('reports:sla.met'), numeric: true },
            { key: 'breached', label: t('reports:sla.breached'), numeric: true },
            { key: 'compliance', label: t('reports:columns.compliance'), numeric: true },
          ]}
          rows={[...priorities.map(tableRow), ...clocks.map(tableRow)]}
        />
      }
    />
  );
}

export function BacklogCard(props: CardProps): ReactNode {
  const t = useT();
  const dayLabel = useDayLabel();
  const { backlog } = props.summary;
  const title = t('reports:backlog.title');
  const first = backlog[0];
  const last = backlog.at(-1);

  return (
    <ChartCard
      title={title}
      caption={t('reports:backlog.caption')}
      {...(last === undefined || first === undefined
        ? {}
        : {
            headline: {
              figure: formatCount(last.open),
              sentence: t(
                last.open >= first.open
                  ? 'reports:backlog.sentenceMore'
                  : 'reports:backlog.sentenceFewer',
                { change: formatCount(Math.abs(last.open - first.open)), day: dayLabel(first.day) },
              ),
            },
          })}
      {...exportProps(props, 'backlog')}
      chart={
        backlog.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('reports:empty')}
          </Typography>
        ) : (
          <LineChart
            label={t('reports:backlog.chartLabel', {
              first: first?.open ?? 0,
              last: last?.open ?? 0,
              days: backlog.length,
            })}
            dayLabels={backlog.map((day) => dayLabel(day.day))}
            values={backlog.map((day) => day.open)}
            endLabel={t('reports:backlog.endLabel', { count: last?.open ?? 0 })}
            tooltipOf={(index) =>
              t('reports:backlog.tooltip', {
                day: dayLabel(backlog[index]?.day ?? ''),
                count: backlog[index]?.open ?? 0,
              })
            }
          />
        )
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'day', label: t('reports:columns.day') },
            { key: 'open', label: t('reports:columns.open'), numeric: true },
          ]}
          rows={backlog.map((day) => ({
            id: day.day,
            day: dayLabel(day.day),
            open: formatCount(day.open),
          }))}
        />
      }
    />
  );
}

export function CsatCard(props: CardProps): ReactNode {
  const t = useT();
  const { csat } = props.summary;
  const title = t('reports:csat.title');
  const shares = csatShares(csat.distribution);
  const rows: ShareRow[] = shares.map((row) => ({
    key: String(row.rating),
    label: t('reports:csat.stars', { count: row.rating }),
    share: row.share,
    value: formatCount(row.responses),
    of: `· ${formatShare(row.share)}`,
  }));

  return (
    <ChartCard
      title={title}
      caption={t('reports:csat.caption')}
      headline={{
        figure: csat.average === null ? '—' : formatAverage(csat.average),
        sentence:
          csat.average === null
            ? t('reports:csat.noAnswers')
            : t('reports:csat.sentence', {
                count: csat.responses,
                satisfied: csat.satisfied === null ? '—' : formatShare(csat.satisfied),
              }),
      }}
      {...exportProps(props, 'csat')}
      chart={
        <ShareRows
          label={t('reports:csat.chartLabel', {
            figures: rows.map((row) => `${row.label} ${row.value}`).join(', '),
          })}
          rows={rows}
        />
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'rating', label: t('reports:columns.rating') },
            { key: 'responses', label: t('reports:columns.responses'), numeric: true },
            { key: 'share', label: t('reports:columns.share'), numeric: true },
          ]}
          rows={shares.map((row) => ({
            id: String(row.rating),
            rating: t('reports:csat.stars', { count: row.rating }),
            responses: formatCount(row.responses),
            share: formatShare(row.share),
          }))}
        />
      }
    />
  );
}

export function AgentsCard(props: CardProps): ReactNode {
  const t = useT();
  const title = t('reports:agents.title');
  const { agents, unassignedOpen, filters } = props.summary;
  const durationOf = (ms: number | null): string => (ms === null ? '—' : formatDuration(ms));
  const rows: Row[] = agents.map((agent) => ({
    id: agent.agentId,
    agent: agent.name ?? t('reports:agents.removed'),
    open: formatCount(agent.assignedOpen),
    resolved: formatCount(agent.resolved),
    replies: formatCount(agent.replies),
    firstResponse: durationOf(agent.firstResponse.medianMs),
    resolution: durationOf(agent.resolution.medianMs),
    sla: agent.sla.compliance === null ? '—' : formatShare(agent.sla.compliance),
    csat: agent.csat.average === null ? '—' : formatAverage(agent.csat.average),
  }));
  // The open tickets nobody has: a row of its own, unless the report is one agent's.
  if (filters.agentId === null && (agents.length > 0 || unassignedOpen > 0)) {
    rows.push({
      id: 'unassigned',
      agent: t('reports:agents.unassigned'),
      open: formatCount(unassignedOpen),
      resolved: '—',
      replies: '—',
      firstResponse: '—',
      resolution: '—',
      sla: '—',
      csat: '—',
    });
  }

  return (
    <ChartCard
      wide
      title={title}
      caption={t('reports:agents.caption')}
      {...exportProps(props, 'agents')}
      chart={
        <DataTable
          label={title}
          empty={t('reports:agents.empty')}
          columns={[
            { key: 'agent', label: t('reports:columns.agent') },
            { key: 'open', label: t('reports:columns.openAssigned'), numeric: true },
            { key: 'resolved', label: t('reports:columns.solved'), numeric: true },
            { key: 'replies', label: t('reports:columns.replies'), numeric: true },
            { key: 'firstResponse', label: t('reports:times.firstResponse'), numeric: true },
            { key: 'resolution', label: t('reports:times.resolution'), numeric: true },
            { key: 'sla', label: t('reports:columns.slaMet'), numeric: true },
            { key: 'csat', label: t('reports:columns.csat'), numeric: true },
          ]}
          rows={rows}
        />
      }
    />
  );
}

const useWeekdayNames = (): string[] => {
  const { locale } = usePreferences();
  const format = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  // 1 January 2024 was a Monday, so ISO weekday n is day n of that month.
  return WEEKDAYS.map((weekday) => format.format(new Date(Date.UTC(2024, 0, weekday))));
};

const hourRange = (hour: number): string =>
  `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`;

export function BusiestHoursCard(props: CardProps): ReactNode {
  const t = useT();
  const dayNames = useWeekdayNames();
  const grid = heatmapGrid(props.summary.busiestHours);
  const title = t('reports:hours.title');
  const cells = grid.flatMap((row, day) => row.map((count, hour) => ({ day, hour, count })));
  const busiest = cells.reduce((top, cell) => (cell.count > top.count ? cell : top), {
    day: 0,
    hour: 0,
    count: -1,
  });
  const quietest = cells.reduce((low, cell) => (cell.count < low.count ? cell : low), {
    day: 0,
    hour: 0,
    count: Number.POSITIVE_INFINITY,
  });
  const describe = (cell: { day: number; hour: number }): string =>
    `${dayNames[cell.day] ?? ''} ${hourRange(cell.hour)}`;

  return (
    <ChartCard
      wide
      title={title}
      caption={t('reports:hours.caption', { timezone: props.summary.range.timezone })}
      {...exportProps(props, 'busiest_hours')}
      chart={
        <Heatmap
          label={t('reports:hours.chartLabel', {
            busiest: describe(busiest),
            busiestCount: Math.max(0, busiest.count),
            quietest: describe(quietest),
            quietestCount: Number.isFinite(quietest.count) ? quietest.count : 0,
          })}
          grid={grid}
          dayNames={dayNames}
          legendLabel={t('reports:hours.legend')}
          tooltipOf={(day, hour, count) =>
            t('reports:hours.tooltip', { day: dayNames[day] ?? '', hours: hourRange(hour), count })
          }
        />
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'day', label: t('reports:columns.weekday') },
            ...HOURS.map((hour) => ({
              key: `h${hour}`,
              label: String(hour).padStart(2, '0'),
              numeric: true,
            })),
          ]}
          rows={grid.map((row, day) => ({
            id: String(WEEKDAYS[day]),
            day: dayNames[day] ?? '',
            ...Object.fromEntries(row.map((count, hour) => [`h${hour}`, String(count)])),
          }))}
        />
      }
    />
  );
}

export function TopSearchesCard(props: CardProps): ReactNode {
  const t = useT();
  const title = t('reports:searches.topTitle');

  return (
    <ChartCard
      title={title}
      caption={t('reports:searches.topCaption')}
      {...exportProps(props, 'searches')}
      chart={
        <DataTable
          label={title}
          empty={t('reports:searches.empty')}
          columns={[
            { key: 'query', label: t('reports:columns.query') },
            { key: 'searches', label: t('reports:columns.searches'), numeric: true },
            { key: 'clicked', label: t('reports:columns.clicked'), numeric: true },
          ]}
          rows={props.summary.searches.top.map((row) => ({
            id: `${row.locale}:${row.query}`,
            query: <SearchQuery query={row.query} locale={row.locale} />,
            searches: formatCount(row.searches),
            clicked: row.openedRate === null ? '—' : formatShare(row.openedRate),
          }))}
        />
      }
    />
  );
}

export function ZeroResultsCard(props: CardProps): ReactNode {
  const t = useT();
  const title = t('reports:searches.zeroTitle');

  return (
    <ChartCard
      title={title}
      caption={t('reports:searches.zeroCaption')}
      {...exportProps(props, 'searches')}
      chart={
        <DataTable
          label={title}
          empty={t('reports:searches.zeroEmpty')}
          columns={[
            { key: 'query', label: t('reports:columns.query') },
            { key: 'searches', label: t('reports:columns.searches'), numeric: true },
            { key: 'action', label: t('reports:columns.action') },
          ]}
          rows={props.summary.searches.zeroResult.map((row) => ({
            id: `${row.locale}:${row.query}`,
            query: <SearchQuery query={row.query} locale={row.locale} />,
            searches: formatCount(row.searches),
            action: (
              <Link component={RouterLink} to={helpCenterRoute('articles')} variant="body2">
                {t('reports:searches.writeArticle')}
              </Link>
            ),
          }))}
        />
      }
    />
  );
}

/** A query in the language it was typed in, with that language named after it. */
function SearchQuery({
  query,
  locale,
}: {
  readonly query: string;
  readonly locale: string;
}): ReactNode {
  return (
    <>
      <bdi lang={locale}>{query}</bdi>{' '}
      <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
        {locale}
      </Typography>
    </>
  );
}

/** The two AI cards: "not available" until M7 binds the AI usage source. */
export function AiCards({ ai }: { readonly ai: ReportSummary['ai'] }): ReactNode {
  const t = useT();

  if (!ai.available) {
    return (
      <>
        <ChartCard
          title={t('reports:ai.deflectionTitle')}
          caption={t('reports:ai.deflectionCaption')}
          chart={<Unavailable />}
        />
        <ChartCard
          title={t('reports:ai.costTitle')}
          caption={t('reports:ai.costCaption')}
          chart={<Unavailable />}
        />
      </>
    );
  }

  return (
    <>
      <ChartCard
        title={t('reports:ai.deflectionTitle')}
        caption={t('reports:ai.deflectionCaption')}
        headline={{
          figure: ai.deflection.rate === null ? '—' : formatShare(ai.deflection.rate),
          sentence: t('reports:ai.deflectionSentence', {
            deflected: formatCount(ai.deflection.deflected),
            eligible: formatCount(ai.deflection.eligible),
          }),
        }}
        chart={
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('reports:ai.deflectionRule')}
          </Typography>
        }
      />
      <ChartCard
        title={t('reports:ai.costTitle')}
        caption={t('reports:ai.costCaption')}
        headline={{
          figure: formatUsd(ai.cost.costUsd),
          sentence: t('reports:ai.costSentence', {
            calls: formatCount(ai.cost.calls),
            tokensIn: formatCount(ai.cost.tokensIn),
            tokensOut: formatCount(ai.cost.tokensOut),
          }),
        }}
        chart={null}
      />
    </>
  );
}

function Unavailable(): ReactNode {
  const t = useT();

  return (
    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
      {t('reports:ai.unavailable')}
    </Typography>
  );
}
