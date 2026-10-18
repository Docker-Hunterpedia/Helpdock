import type { ImportRunView } from '@helpdock/schemas';
import { Box, Button, Skeleton, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { SectionCard } from '../channels/section-card.tsx';

export function ImportSla({ run }: { run: ImportRunView }) {
  const t = useT();
  const { locale } = usePreferences();
  const api = useImportsApi();
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const key = ['imports', run.brandId, 'run', run.id, 'sla'];
  const overview = useQuery({
    queryKey: key,
    queryFn: () => api.sla(run.brandId, run.id),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.activation?.status ?? '') ? 2000 : false,
  });
  const start = useMutation({
    mutationFn: () => api.startSla(run.brandId, run.id),
    onSuccess: (value) => {
      setConfirm(false);
      cache.setQueryData(key, value);
    },
  });
  const active = ['queued', 'running'].includes(overview.data?.activation?.status ?? '');
  const failed = overview.data?.activation?.status === 'failed';
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  const eligible = overview.data?.eligible ?? 0;
  return (
    <SectionCard
      id="import-sla"
      heading={t('imports:sla.title')}
      caption={t('imports:sla.caption', {
        source: run.sourceAccount ?? t(`imports:sources.${run.source}`),
      })}
    >
      {overview.isPending ? <Skeleton /> : null}
      {overview.isError ? (
        <AlertBanner tone="danger">
          {t('imports:loadFailed')}{' '}
          <Button onClick={() => void overview.refetch()}>{t('imports:retry')}</Button>
        </AlertBanner>
      ) : null}
      {start.isError ? (
        <AlertBanner tone="danger">{t('imports:sla.failedRequest')}</AlertBanner>
      ) : null}
      {failed ? <AlertBanner tone="danger">{t('imports:sla.failed')}</AlertBanner> : null}
      {overview.data?.activation ? (
        <Box role="status" sx={{ display: 'grid', gap: 2 }}>
          <Typography>{t(`imports:sla.status.${overview.data.activation.status}`)}</Typography>
          <Typography variant="caption">
            {t('imports:sla.counts', {
              checked: number.format(overview.data.activation.checked),
              started: number.format(overview.data.activation.started),
              skipped: number.format(overview.data.activation.skipped),
            })}
          </Typography>
        </Box>
      ) : null}
      {overview.data && !overview.data.available ? (
        <AlertBanner tone="info">{t('imports:sla.unavailable')}</AlertBanner>
      ) : null}
      <Button
        variant="outlined"
        startIcon={<Clock size={16} aria-hidden="true" />}
        disabled={
          overview.isError ||
          !overview.data?.available ||
          active ||
          start.isPending ||
          (!eligible && !failed)
        }
        onClick={() => setConfirm(true)}
      >
        {failed ? t('imports:sla.retry') : t('imports:sla.start', { count: eligible })}
      </Button>
      <ConfirmDialog
        open={confirm}
        title={failed ? t('imports:sla.retry') : t('imports:sla.title')}
        body={t('imports:sla.confirm', {
          count: eligible,
          source: run.sourceAccount ?? t(`imports:sources.${run.source}`),
        })}
        confirmLabel={failed ? t('imports:sla.retry') : t('imports:sla.start', { count: eligible })}
        busy={start.isPending}
        onConfirm={() => start.mutate()}
        onClose={() => setConfirm(false)}
      />
    </SectionCard>
  );
}
