import type { ReportExport, ReportSummary } from '@helpdock/schemas';
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
  ColumnChart,
  Heatmap,
  LineChart,
  SERIES_PRIMARY,
  SERIES_SECONDARY,
  type ShareRow,
  ShareRows,
} from './charts.js';
import { DataTable } from './data-table.js';
import { HOURS, heatmapGrid, WEEKDAYS } from './heatmap-scale.js';
import { csatShares, slaTotals } from './kpis.js';
import { formatAverage, formatDuration } from './report-format.js';

/**
 * Every card of `Admin/Reports` (M8-04) but the KPI tiles, each drawn from
 * `GET /api/brands/:brandId/reports` and exporting its rows through the CSV
 * route. Where the artboard draws something the summary does not carry (a
 * series per channel per day, SLA by priority, per-agent times) the card
 * draws what the api has and the milestone doc lists the difference.
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

export function VolumeCard(props: CardProps): ReactNode {
  const t = useT();
  const dayLabel = useDayLabel();
  const [breakdown, setBreakdown] = useState<VolumeBreakdown>('channel');
  const { volume } = props.summary;
  const days = volume.byDay;
  const title = t('reports:volume.title');

  const shares: ShareRow[] = (() => {
    const total = Math.max(1, volume.created);
    if (breakdown === 'channel') {
      return volume.byChannel.map((row) => ({
        key: row.channel,
        label: t(`tickets:channel.${row.channel}`),
        share: row.created / total,
        value: formatCount(row.created),
      }));
    }
    if (breakdown === 'priority') {
      return volume.byPriority.map((row) => ({
        key: row.priority,
        label: t(`tickets:priority.${row.priority}`),
        share: row.created / total,
        value: formatCount(row.created),
      }));
    }
    return volume.byStatus.map((row) => ({
      key: row.statusId,
      label: row.name,
      share: row.tickets / total,
      value: formatCount(row.tickets),
    }));
  })();
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
      {...exportProps(props, 'volume')}
      chart={
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 260px' },
            gap: 4,
            alignItems: 'start',
          }}
        >
          <ColumnChart
            label={t('reports:volume.chartLabel', {
              created: volume.created,
              resolved: volume.resolved,
              days: days.length,
            })}
            dayLabels={days.map((day) => dayLabel(day.day))}
            values={days.map((day) => day.created)}
            tooltipOf={(index) =>
              t('reports:volume.tooltip', {
                day: dayLabel(days[index]?.day ?? ''),
                count: days[index]?.created ?? 0,
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
          </Box>
        </Box>
      }
      table={
        <DataTable
          label={title}
          empty={t('reports:empty')}
          columns={[
            { key: 'day', label: t('reports:columns.day') },
            { key: 'created', label: t('reports:columns.created'), numeric: true },
            { key: 'resolved', label: t('reports:columns.resolved'), numeric: true },
          ]}
          rows={days.map((day) => ({
            id: day.day,
            day: dayLabel(day.day),
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
  const rows: ShareRow[] = clocks.map((clock) => {
    const finished = clock.outcome.met + clock.outcome.breached;
    return {
      key: clock.key,
      label: clock.label,
      share: clock.outcome.compliance ?? 0,
      value: clock.outcome.compliance === null ? '—' : formatShare(clock.outcome.compliance),
      of: t('reports:of', { count: finished }),
      colour: tokens['status.success'],
    };
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
          <Typography variant="caption" component="h3" sx={{ margin: 0 }}>
            {t('reports:sla.byClock')}
          </Typography>
          <ShareRows
            label={t('reports:sla.chartLabel', {
              figures: rows.map((row) => `${row.label} ${row.value} ${row.of ?? ''}`).join(', '),
            })}
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
            { key: 'clock', label: t('reports:columns.clock') },
            { key: 'met', label: t('reports:sla.met'), numeric: true },
            { key: 'breached', label: t('reports:sla.breached'), numeric: true },
            { key: 'compliance', label: t('reports:columns.compliance'), numeric: true },
          ]}
          rows={clocks.map((clock) => ({
            id: clock.key,
            clock: clock.label,
            met: formatCount(clock.outcome.met),
            breached: formatCount(clock.outcome.breached),
            compliance:
              clock.outcome.compliance === null ? '—' : formatShare(clock.outcome.compliance),
          }))}
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
          ]}
          rows={props.summary.agents.map((agent) => ({
            id: agent.agentId,
            agent: agent.name ?? t('reports:agents.removed'),
            open: formatCount(agent.assignedOpen),
            resolved: formatCount(agent.resolved),
            replies: formatCount(agent.replies),
          }))}
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
