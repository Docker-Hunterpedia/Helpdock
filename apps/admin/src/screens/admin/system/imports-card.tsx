import type { ImportHealth } from '@helpdock/schemas';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { ROUTES } from '../../../app/route-paths.js';
import { useSessionQuery } from '../../../auth/session.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { formatClock, formatDay } from '../../../ui/format.js';
import { Card } from './card.js';
import { SYSTEM_QUERY_KEY, type SystemApi } from './system-api.js';

export function ImportsCard({
  health: latest,
  api,
}: {
  health: ImportHealth | undefined;
  api: SystemApi;
}) {
  const t = useT();
  const { locale } = usePreferences();
  const { data: session } = useSessionQuery();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<{ snapshotId: string; page: number } | null>(null);
  const page = useQuery({
    queryKey: ['install', 'system', 'imports', selection?.snapshotId, selection?.page],
    queryFn: () => {
      if (!selection) throw new Error('import.health-page-not-selected');
      return api.imports(selection);
    },
    enabled: selection !== null,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const health = selection ? page.data : latest;
  const currentPage = selection?.page ?? 1;
  const pending = selection !== null && page.isPending;
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  return (
    <Card title={t('system:imports.title')}>
      <Box sx={{ display: 'grid', gap: 3 }}>
        {pending ? (
          <Skeleton variant="rounded" height={96} aria-label={t('system:imports.loading')} />
        ) : selection && page.isError ? (
          <AlertBanner tone="danger">
            {t('system:imports.failed')}
            <Button onClick={() => void page.refetch()}>{t('system:imports.retry')}</Button>
          </AlertBanner>
        ) : !health?.configured ? (
          <Typography color="text.secondary">{t('system:imports.unavailable')}</Typography>
        ) : (
          <>
            <Typography>
              {t('system:imports.counts', {
                active: number.format(health.active),
                paused: number.format(health.paused),
              })}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('system:imports.measured')}{' '}
              <bdi>
                <time dateTime={health.observedAt}>
                  {formatDay(health.observedAt, locale)} · {formatClock(health.observedAt, locale)}
                </time>
              </bdi>
            </Typography>
            {health.totalBrands === 0 ? (
              <Typography color="text.secondary">{t('system:imports.empty')}</Typography>
            ) : (
              <TableContainer>
                <Table size="small" aria-label={t('system:imports.title')}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('system:imports.brand')}</TableCell>
                      <TableCell>{t('system:imports.active')}</TableCell>
                      <TableCell>{t('system:imports.paused')}</TableCell>
                      <TableCell>{t('system:imports.lastError')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {health.brands.map((brand) => (
                      <TableRow key={brand.brandId}>
                        <TableCell component="th" scope="row">
                          <bdi>{brand.brandName}</bdi>
                        </TableCell>
                        <TableCell>
                          <bdi dir="ltr">{number.format(brand.active)}</bdi>
                        </TableCell>
                        <TableCell>
                          <bdi dir="ltr">{number.format(brand.paused)}</bdi>
                        </TableCell>
                        <TableCell sx={{ overflowWrap: 'anywhere' }}>
                          {brand.lastError ? (
                            <>
                              <Typography variant="caption">
                                {t(`imports:sources.${brand.lastError.source}`)} ·{' '}
                                <bdi>{formatDay(brand.lastError.at, locale)}</bdi>
                              </Typography>
                              <Typography variant="caption" component="div" color="text.secondary">
                                <bdi>{brand.lastError.code}</bdi>
                              </Typography>
                            </>
                          ) : (
                            <Typography variant="caption" color="text.secondary">
                              {t('system:imports.noRetainedError')}
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
            {health.totalBrands > 0 ? (
              <Typography variant="caption" color="text.secondary">
                {t('system:imports.shown', {
                  from: number.format((currentPage - 1) * 50 + (health.brands.length ? 1 : 0)),
                  to: number.format((currentPage - 1) * 50 + health.brands.length),
                  total: number.format(health.totalBrands),
                })}
              </Typography>
            ) : null}
            {health.snapshotId && health.totalBrands > 50 ? (
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <Button
                  disabled={currentPage === 1}
                  onClick={() => {
                    if (health.snapshotId)
                      setSelection({ snapshotId: health.snapshotId, page: currentPage - 1 });
                  }}
                >
                  {t('system:imports.previous')}
                </Button>
                <Button
                  disabled={currentPage * 50 >= health.totalBrands}
                  onClick={() => {
                    if (health.snapshotId)
                      setSelection({ snapshotId: health.snapshotId, page: currentPage + 1 });
                  }}
                >
                  {t('system:imports.next')}
                </Button>
              </Box>
            ) : !health.snapshotId && health.totalBrands > health.brands.length ? (
              <Typography variant="caption" color="text.secondary">
                {t('system:imports.waitForSnapshot')}
              </Typography>
            ) : null}
          </>
        )}
        {selection ? (
          <Box>
            <Button
              onClick={() => {
                setSelection(null);
                void queryClient.invalidateQueries({ queryKey: SYSTEM_QUERY_KEY, exact: true });
              }}
            >
              {t('system:imports.latest')}
            </Button>
          </Box>
        ) : null}
        {session?.user.role === 'admin' ? (
          <Box>
            <Button component={Link} to={ROUTES.brandImport}>
              {t('system:imports.openCurrent')}
            </Button>
          </Box>
        ) : null}
      </Box>
    </Card>
  );
}
