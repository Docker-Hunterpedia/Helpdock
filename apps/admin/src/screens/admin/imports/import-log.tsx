import type { ImportLogQuery, ImportRunView } from '@helpdock/schemas';
import {
  Box,
  Button,
  MenuItem,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.js';
import { formatClock, formatDay } from '../../../ui/format.js';
import { SectionCard } from '../channels/section-card.tsx';
import { importLogMessageKey } from './import-log-messages.js';

type PagePosition = { after: number; through: number } | null;

export function ImportLog({ run }: { run: ImportRunView }) {
  const api = useImportsApi();
  const t = useT();
  const id = useId();
  const { locale } = usePreferences();
  const [level, setLevel] = useState<ImportLogQuery['level']>();
  const [positions, setPositions] = useState<PagePosition[]>([null]);
  const position = positions.at(-1) ?? null;
  const query: ImportLogQuery = {
    direction: 'desc',
    limit: 50,
    ...(position ?? {}),
    ...(level ? { level } : {}),
  };
  const active = ['extracting', 'dry_run', 'loading', 'finishing'].includes(run.status);
  const log = useQuery({
    queryKey: ['imports', run.brandId, 'run', run.id, 'log', run.status, query],
    queryFn: () => api.log(run.brandId, run.id, query),
    refetchInterval: active && position === null ? 2000 : false,
  });
  const download = useMutation({
    mutationFn: () => api.exportLog(run.brandId, run.id, level ? { level } : {}),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `helpdock-import-${run.id}.csv`;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  });
  const description = (code: string) => {
    const skipped = /^import\.file-rows-skipped:(\d+)$/.exec(code);
    if (skipped) return t('imports:log.skippedRows', { count: Number(skipped[1]) });
    const key = importLogMessageKey(code);
    return key ? t(`imports:log.messages.${key}`) : t('imports:log.other');
  };
  return (
    <SectionCard
      id="import-log"
      heading={t('imports:log.title')}
      caption={position === null ? t('imports:log.liveCaption') : t('imports:log.snapshotCaption')}
      footer={
        <Button
          startIcon={<Download size={16} aria-hidden="true" />}
          disabled={download.isPending || log.isPending}
          onClick={() => download.mutate()}
        >
          {t('imports:log.download')}
        </Button>
      }
    >
      <Field id={id} label={t('imports:log.filter')}>
        <TextField
          id={id}
          select
          slotProps={{ select: { inputProps: { 'aria-label': t('imports:log.filter') } } }}
          size="small"
          value={level ?? 'all'}
          onChange={(event) => {
            const next = event.target.value;
            setLevel(next === 'info' || next === 'warning' || next === 'error' ? next : undefined);
            setPositions([null]);
          }}
        >
          <MenuItem value="all">{t('imports:log.all')}</MenuItem>
          {(['info', 'warning', 'error'] as const).map((value) => (
            <MenuItem key={value} value={value}>
              {t(`imports:log.levels.${value}`)}
            </MenuItem>
          ))}
        </TextField>
      </Field>
      {download.isError ? (
        <AlertBanner tone="danger">{t('imports:log.downloadFailed')}</AlertBanner>
      ) : null}
      {log.isError ? (
        <AlertBanner tone="danger">
          {t('imports:loadFailed')}{' '}
          <Button onClick={() => void log.refetch()}>{t('imports:retry')}</Button>
        </AlertBanner>
      ) : null}
      {log.isPending ? <Skeleton /> : null}
      {log.data?.entries.length === 0 ? (
        <Typography color="text.secondary">{t('imports:log.empty')}</Typography>
      ) : null}
      <TableContainer>
        <Table size="small" aria-label={t('imports:log.title')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('imports:log.time')}</TableCell>
              <TableCell>{t('imports:log.level')}</TableCell>
              <TableCell>{t('imports:log.record')}</TableCell>
              <TableCell>{t('imports:log.message')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {log.data?.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  <bdi>
                    <time dateTime={entry.at}>
                      {formatDay(entry.at, locale)} · {formatClock(entry.at, locale)}
                    </time>
                  </bdi>
                </TableCell>
                <TableCell>{t(`imports:log.levels.${entry.level}`)}</TableCell>
                <TableCell sx={{ overflowWrap: 'anywhere' }}>
                  {entry.entity ? t(`imports:entities.${entry.entity}`) : '—'}
                  {entry.externalId ? (
                    <Typography variant="caption" component="div">
                      <bdi>{entry.externalId}</bdi>
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell sx={{ overflowWrap: 'anywhere' }}>
                  <Typography>{description(entry.message)}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    <bdi>{entry.message}</bdi>
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button
          disabled={positions.length === 1 || log.isFetching}
          onClick={() => setPositions((previous) => previous.slice(0, -1))}
        >
          {t('imports:log.newer')}
        </Button>
        <Button
          disabled={log.isFetching || log.data?.nextCursor === null || !log.data}
          onClick={() => {
            const next = log.data?.nextCursor;
            if (typeof next === 'number' && log.data)
              setPositions((previous) => [...previous, { after: next, through: log.data.through }]);
          }}
        >
          {t('imports:log.older')}
        </Button>
        {position !== null ? (
          <Button onClick={() => setPositions([null])}>{t('imports:log.latest')}</Button>
        ) : (
          <Button disabled={log.isFetching} onClick={() => void log.refetch()}>
            {t('imports:log.refresh')}
          </Button>
        )}
      </Box>
    </SectionCard>
  );
}
