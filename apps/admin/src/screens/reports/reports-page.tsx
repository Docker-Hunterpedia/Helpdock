import { type ReportExport, type ReportQuery, reportExportFileName } from '@helpdock/schemas';
import { Box, Skeleton, Typography } from '@mui/material';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { ChartColumn, Info } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../auth/session.tsx';
import { useReportsApi } from '../../reports/context.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import { PageHeader } from '../../shell/page-header.tsx';
import { formatClock } from '../../ui/format.js';
import { useToast } from '../../ui/toasts.tsx';
import { KpiTiles } from './kpi-tiles.js';
import {
  AgentsCard,
  AiCards,
  BacklogCard,
  BusiestHoursCard,
  type CardProps,
  CsatCard,
  ResponseTimesCard,
  SlaCard,
  TopSearchesCard,
  VolumeCard,
  ZeroResultsCard,
} from './report-cards.js';
import { ReportFilterBar, type ReportFilters, useRangeLabel } from './report-filters.js';
import { DEFAULT_PRESET, presetRange, previousRange, rangeDays } from './report-range.js';

/**
 * `Admin/Reports` (M8-04): filters, four KPI tiles and a ChartCard per
 * report, every number from `GET /api/brands/:brandId/reports` and every card
 * exportable as CSV. `report:read` is an Admin's, a Team Leader's and a
 * Viewer's; the sidebar offers it to those three, and the rollups' row-level
 * security decides which departments' numbers each of them gets.
 */

const queryOf = (filters: ReportFilters, range = filters.range): ReportQuery => ({
  from: range.from,
  to: range.to,
  ...(filters.departmentId === undefined ? {} : { departmentId: filters.departmentId }),
  ...(filters.channel === undefined ? {} : { channel: filters.channel }),
});

/** Saves a CSV the api answered with, under the name the api gives it. */
const download = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function ReportsPage(): ReactNode {
  const t = useT();
  const session = useSession();
  const brand = currentBrand(session);
  const api = useReportsApi();
  const ticketing = useTicketingApi();
  const toast = useToast();
  const rangeLabel = useRangeLabel();
  const [filters, setFilters] = useState<ReportFilters>(() => ({
    range: presetRange(DEFAULT_PRESET),
    departmentId: undefined,
    channel: undefined,
  }));
  const query = queryOf(filters);
  const previous = previousRange(filters.range);

  const summary = useQuery({
    queryKey: ['reports', brand.id, query],
    queryFn: () => api.summary(brand.id, query),
    placeholderData: keepPreviousData,
  });
  const before = useQuery({
    queryKey: ['reports', brand.id, queryOf(filters, previous)],
    queryFn: () => api.summary(brand.id, queryOf(filters, previous)),
    enabled: summary.isSuccess,
  });
  // A Viewer may not read departments; the filter then offers "All" alone.
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
    retry: false,
  });

  const exporter = useMutation({
    mutationFn: async (report: ReportExport) => {
      download(
        await api.exportCsv(brand.id, report, query),
        reportExportFileName(report, query.from, query.to),
      );
    },
    onError: () => {
      toast({ tone: 'danger', message: t('reports:exportFailed') });
    },
  });

  const header = (
    <PageHeader title={t('reports:title')} caption={t('reports:caption', { brand: brand.name })} />
  );

  if (summary.isError && summary.data === undefined) {
    return (
      <>
        {header}
        <EmptyState
          icon={ChartColumn}
          heading={t('reports:error.heading')}
          body={t('reports:error.body')}
        />
      </>
    );
  }

  const cardProps: Omit<CardProps, 'summary'> = {
    onExport: (report) => {
      exporter.mutate(report);
    },
    exporting: exporter.isPending ? (exporter.variables ?? null) : null,
  };

  return (
    <>
      {header}
      <Box sx={{ display: 'grid', gap: 6 }}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 4,
          }}
        >
          <ReportFilterBar
            filters={filters}
            departments={departments.data?.departments ?? []}
            onChange={setFilters}
          />
          {summary.data === undefined ? null : (
            <RollupNote comparedWith={rangeLabel(previous)} computedAt={summary.data.computedAt} />
          )}
        </Box>

        {summary.data === undefined ? (
          <Box role="status" aria-live="polite" sx={{ display: 'grid', gap: 4 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('reports:loading')}
            </Typography>
            <Skeleton variant="rounded" height={96} />
            <Skeleton variant="rounded" height={280} />
          </Box>
        ) : (
          <>
            <KpiTiles
              current={summary.data}
              previous={before.data}
              days={rangeDays(filters.range)}
            />
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
                gap: 4,
                alignItems: 'start',
              }}
            >
              <VolumeCard summary={summary.data} {...cardProps} />
              <ResponseTimesCard summary={summary.data} {...cardProps} />
              <SlaCard summary={summary.data} {...cardProps} />
              <BacklogCard summary={summary.data} {...cardProps} />
              <CsatCard summary={summary.data} {...cardProps} />
              <AgentsCard summary={summary.data} {...cardProps} />
              <BusiestHoursCard summary={summary.data} {...cardProps} />
              <TopSearchesCard summary={summary.data} {...cardProps} />
              <ZeroResultsCard summary={summary.data} {...cardProps} />
              <AiCards ai={summary.data.ai} />
            </Box>
            <TableNote />
          </>
        )}
      </Box>
    </>
  );
}

function RollupNote({
  comparedWith,
  computedAt,
}: {
  readonly comparedWith: string;
  readonly computedAt: string | null;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  return (
    <Box sx={{ textAlign: 'end' }}>
      <Typography variant="caption" component="p" sx={{ color: 'text.secondary', fontWeight: 400 }}>
        {t('reports:comparedWith', { range: comparedWith })}
      </Typography>
      <Typography variant="caption" component="p" sx={{ color: 'text.secondary', fontWeight: 400 }}>
        {computedAt === null
          ? t('reports:notRolledUp')
          : t('reports:rolledUp', { time: formatClock(computedAt, locale) })}
      </Typography>
    </Box>
  );
}

function TableNote(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 2,
        paddingBlock: 3,
        paddingInline: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['status.info']}`,
        backgroundColor: tokens['status.info.tint'],
        color: tokens['status.info.text'],
      }}
    >
      <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
      <Typography variant="body2" sx={{ color: 'inherit' }}>
        {t('reports:tableNote')}
      </Typography>
    </Box>
  );
}
