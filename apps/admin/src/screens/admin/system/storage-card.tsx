import type { SystemStorage } from '@helpdock/schemas';
import { Box, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { formatClock } from '../../../ui/format.js';
import { UsageMeter } from '../../../ui/usage-meter.js';
import { Card } from './card.js';
import { formatBytes, percentOf } from './format.js';

/**
 * Storage on `Admin/System-1.0` (M8-05): attachments and article images in
 * the bucket, against the soft limit, and per brand. The worker measures it
 * (`stats.rollup`), so until its first reading there is nothing to draw and the
 * card says so. The artboard's Postgres column is not drawn: the api does not
 * measure the database per brand.
 */
export function StorageCard({
  storage,
  pendingBrandIds,
}: {
  readonly storage: SystemStorage;
  /** Brands in their deletion grace, which the table marks. */
  readonly pendingBrandIds: ReadonlySet<string>;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  if (!storage.configured) {
    return (
      <Card title={t('system:storage.title')}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:storage.pending')}
        </Typography>
      </Card>
    );
  }

  const brands = storage.brands ?? [];
  const measuredAt = brands.reduce<string | null>(
    (latest, brand) => (latest === null || brand.measuredAt > latest ? brand.measuredAt : latest),
    null,
  );
  const percent =
    storage.softLimitBytes === null ? 0 : percentOf(storage.usedBytes, storage.softLimitBytes);

  return (
    <Card
      title={t('system:storage.title')}
      action={
        measuredAt === null ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('system:storage.measured', { time: formatClock(measuredAt, locale) })}
          </Typography>
        )
      }
    >
      <Box sx={{ display: 'grid', gap: 4 }}>
        {storage.softLimitBytes === null ? (
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('system:storage.files')}
            </Typography>
            <Typography variant="mono" component="p" sx={{ fontSize: 20, lineHeight: '28px' }}>
              <bdi dir="ltr">{formatBytes(storage.usedBytes)}</bdi>
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
              {t('system:storage.noLimit')}
            </Typography>
          </Box>
        ) : (
          <UsageMeter
            label={t('system:storage.files')}
            figure={formatBytes(storage.usedBytes)}
            percent={percent}
            accessibleLabel={t('system:storage.meterLabel', { percent })}
            caption={t('system:storage.ofLimit', {
              percent,
              limit: formatBytes(storage.softLimitBytes),
            })}
          />
        )}

        {brands.length === 0 ? null : (
          <Table size="small" aria-label={t('system:storage.byBrand')}>
            <TableHead>
              <TableRow>
                <TableCell>{t('system:storage.brand')}</TableCell>
                <TableCell sx={{ textAlign: 'end' }}>{t('system:storage.files')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {brands.map((brand) => (
                <TableRow key={brand.brandId}>
                  <TableCell>
                    {brand.name}
                    {pendingBrandIds.has(brand.brandId) ? (
                      <Typography component="span" variant="body2" sx={{ color: 'text.secondary' }}>
                        {` · ${t('system:storage.pendingDeletion')}`}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell sx={{ textAlign: 'end' }}>
                    <Typography variant="mono" component="span">
                      <bdi dir="ltr">{formatBytes(brand.usedBytes)}</bdi>
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>
    </Card>
  );
}
