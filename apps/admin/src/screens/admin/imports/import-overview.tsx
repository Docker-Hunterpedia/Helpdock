import { type ImportSource, importSourceSchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileUp } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { importRunRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { importKeys } from '../../../imports/api.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { formatClock, formatDay } from '../../../ui/format.js';
import { SectionCard } from '../channels/section-card.tsx';
import { ImportStatus } from './import-status.js';

/** Admin/Import: a source chooser and the current brand's recent runs. */
export function ImportOverview() {
  const session = useSession();
  const t = useT();
  if (session.user.role !== 'admin')
    return <AlertBanner tone="danger">{t('imports:notAllowed')}</AlertBanner>;
  return <ImportOverviewContent brandId={currentBrand(session).id} />;
}

function ImportOverviewContent({ brandId }: { brandId: string }) {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const api = useImportsApi();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const runs = useQuery({
    queryKey: importKeys.runs(brandId),
    queryFn: () => api.runs(brandId),
    refetchInterval: 10000,
  });
  const sources = useQuery({
    queryKey: ['imports', brandId, 'sources'],
    queryFn: () => api.sources(brandId),
  });
  const create = useMutation({
    mutationFn: (source: ImportSource) => api.create(brandId, { source, mode: 'full' }),
    onSuccess: (run) => {
      cache.setQueryData(importKeys.run(brandId, run.id), run);
      void cache.invalidateQueries({ queryKey: importKeys.runs(brandId) });
      navigate(importRunRoute(run.id));
    },
  });
  return (
    <Box sx={{ display: 'grid', gap: 5 }}>
      {create.isError ? <AlertBanner tone="danger">{t('imports:createFailed')}</AlertBanner> : null}
      <SectionCard
        id="new-import"
        heading={t('imports:new.title')}
        caption={t('imports:new.caption')}
      >
        {sources.isError ? (
          <AlertBanner tone="danger">{t('imports:loadFailed')}</AlertBanner>
        ) : null}
        {sources.isPending ? (
          <Skeleton variant="rectangular" height={64} />
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'minmax(0, 1fr)',
                sm: 'repeat(2, minmax(0, 1fr))',
                lg: 'repeat(4, minmax(0, 1fr))',
              },
              gap: 4,
            }}
          >
            {importSourceSchema.options.map((source) => {
              const enabled = sources.data?.sources.includes(source) === true;
              const Icon = source === 'file' ? FileUp : Download;
              return (
                <Box
                  component="button"
                  type="button"
                  key={source}
                  disabled={!enabled || create.isPending}
                  onClick={() => create.mutate(source)}
                  sx={{
                    textAlign: 'start',
                    font: 'inherit',
                    display: 'grid',
                    alignContent: 'start',
                    gap: 2,
                    padding: 4,
                    border: `1px solid ${tokens['border.default']}`,
                    borderRadius: '6px',
                    backgroundColor: tokens['bg.surface'],
                    color: tokens['text.primary'],
                    cursor: enabled ? 'pointer' : 'not-allowed',
                    '&:hover:not(:disabled)': {
                      borderColor: tokens['action.primary'],
                      backgroundColor: tokens['action.primary.tint'],
                    },
                    '&:disabled': { color: tokens['text.secondary'] },
                  }}
                >
                  <Box
                    component="span"
                    sx={{ display: 'flex', alignItems: 'center', gap: 2, fontWeight: 600 }}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <bdi>{t(`imports:sources.${source}`)}</bdi>
                  </Box>
                  <Typography component="span" variant="caption" color="text.secondary">
                    {enabled
                      ? t(source === 'file' ? 'imports:new.manual' : 'imports:new.automatic')
                      : t('imports:new.unavailable')}
                  </Typography>
                  <Typography component="span" variant="body2">
                    {t(`imports:descriptions.${source}`)}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        )}
      </SectionCard>
      <SectionCard
        id="imports-history"
        heading={t('imports:history.title')}
        caption={t('imports:history.caption')}
      >
        {runs.isError ? (
          <AlertBanner tone="danger">
            {t('imports:loadFailed')}{' '}
            <Button onClick={() => void runs.refetch()}>{t('imports:retry')}</Button>
          </AlertBanner>
        ) : null}
        {runs.isPending ? (
          <Box role="status" aria-label={t('imports:loading')}>
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </Box>
        ) : null}
        {runs.data?.runs.length === 0 ? (
          <Box sx={{ textAlign: 'center', paddingBlock: 8 }}>
            <Download size={24} aria-hidden="true" />
            <Typography component="h2" variant="h2">
              {t('imports:history.emptyTitle')}
            </Typography>
            <Typography color="text.secondary">{t('imports:history.emptyBody')}</Typography>
          </Box>
        ) : null}
        {runs.data?.runs.length ? (
          <TableContainer>
            <Table size="small" aria-label={t('imports:history.title')}>
              <TableHead>
                <TableRow>
                  {(
                    ['source', 'mode', 'started', 'actor', 'tickets', 'status', 'action'] as const
                  ).map((key) => (
                    <TableCell key={key}>{t(`imports:history.columns.${key}`)}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.data.runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <bdi>{t(`imports:sources.${run.source}`)}</bdi>
                    </TableCell>
                    <TableCell>{t(`imports:mode.${run.mode}`)}</TableCell>
                    <TableCell>
                      {run.startedAt ? (
                        <bdi>
                          <time dateTime={run.startedAt}>
                            {formatDay(run.startedAt, locale)}
                            {' · '}
                            {formatClock(run.startedAt, locale)}
                          </time>
                        </bdi>
                      ) : (
                        t('imports:history.notStarted')
                      )}
                    </TableCell>
                    <TableCell>
                      {run.startedBy?.name ?? t('imports:history.unknownActor')}
                    </TableCell>
                    <TableCell>
                      <bdi dir="ltr">
                        {new Intl.NumberFormat(locale, { numberingSystem: 'latn' }).format(
                          run.counts.loaded.ticket ?? 0,
                        )}
                      </bdi>
                    </TableCell>
                    <TableCell>
                      <ImportStatus status={run.status} />
                    </TableCell>
                    <TableCell>
                      <Button component={Link} to={importRunRoute(run.id)} size="small">
                        {t('imports:history.open')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : null}
      </SectionCard>
    </Box>
  );
}
