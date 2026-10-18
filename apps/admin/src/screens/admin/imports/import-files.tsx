import { type ImportEntity, importEntitySchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  LinearProgress,
  MenuItem,
  Skeleton,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { importKeys } from '../../../imports/api.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { uploadImportSource } from '../../../imports/upload.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Field } from '../../../ui/field.js';
import { SectionCard } from '../channels/section-card.tsx';
import { ImportFileMapper } from './import-file-mapper.js';

export function ImportFiles({
  brandId,
  runId,
  onBusy,
  onReady,
  inventory = false,
  onInventoryRevision,
}: {
  brandId: string;
  runId: string;
  onBusy: (busy: boolean) => void;
  onReady: (ready: boolean) => void;
  inventory?: boolean;
  onInventoryRevision?: (revision: string) => void;
}) {
  const t = useT();
  const api = useImportsApi();
  const cache = useQueryClient();
  const id = useId();
  const { locale } = usePreferences();
  const [format, setFormat] = useState<'csv' | 'bundle'>('csv');
  const [entity, setEntity] = useState<ImportEntity>('ticket');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [busyFiles, setBusyFiles] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const files = useQuery({
    queryKey: importKeys.files(brandId, runId),
    queryFn: () => api.files(brandId, runId),
    refetchInterval: (query) =>
      query.state.data?.files.some((source) => source.validationPending) ? 2000 : false,
  });
  const selected = useQuery({
    queryKey: [...importKeys.files(brandId, runId), selectedFileId],
    enabled: selectedFileId !== null,
    queryFn: () => {
      if (selectedFileId === null) throw new Error('import.file-required');
      return api.file(brandId, runId, selectedFileId);
    },
    refetchInterval: (query) => {
      const source = query.state.data;
      return source?.status === 'ready' &&
        ((source.mapping && !source.validation) ||
          (source.inventoryMapping?.idColumn && !source.inventoryValidation))
        ? 2000
        : false;
    },
    gcTime: 0,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: importKeys.files(brandId, runId) });
  const inventoryRevision = JSON.stringify(
    files.data?.files.map((file) => [
      file.id,
      file.revision,
      file.status,
      file.inventoryValidation,
    ]) ?? [],
  );
  useEffect(() => {
    onInventoryRevision?.(inventoryRevision);
  }, [inventoryRevision, onInventoryRevision]);
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('import.file-required');
      controller.current = new AbortController();
      setProgress(0);
      return uploadImportSource({
        api,
        brandId,
        runId,
        file,
        source: inventory
          ? {
              format: 'csv',
              entity: 'ticket',
              inventoryMapping: { idColumn: null, location: 'auto' },
            }
          : format === 'csv'
            ? { format, entity }
            : { format },
        signal: controller.current.signal,
        onProgress: (value) =>
          setProgress(value.ratio === undefined ? null : Math.round(value.ratio * 100)),
      });
    },
    onMutate: () => onBusy(true),
    onSuccess: (source) => {
      setSelectedFileId(source.id);
      setFile(null);
      if (input.current) input.current.value = '';
    },
    onSettled: async () => {
      controller.current = null;
      setProgress(null);
      try {
        await refresh();
      } finally {
        onBusy(false);
      }
    },
  });
  const remove = useMutation({
    mutationFn: (fileId: string) => api.discardFile(brandId, runId, fileId),
    onMutate: () => onBusy(true),
    onSuccess: (_value, fileId) => {
      setRemoveId(null);
      if (selectedFileId === fileId) setSelectedFileId(null);
      setDirtyFiles((previous) => {
        const next = new Set(previous);
        next.delete(fileId);
        return next;
      });
    },
    onSettled: async () => {
      try {
        await refresh();
      } finally {
        onBusy(false);
      }
    },
  });
  const busy = upload.isPending || remove.isPending || busyFiles.size > 0;
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  const ready =
    !files.isError &&
    dirtyFiles.size === 0 &&
    !!files.data?.files.length &&
    files.data.files.every((source) => source.readyForExtraction);
  useEffect(() => {
    onReady(ready);
  }, [ready, onReady]);
  return (
    <SectionCard
      id="import-files"
      heading={t(inventory ? 'imports:inventory.title' : 'imports:files.title')}
      caption={t(inventory ? 'imports:inventory.caption' : 'imports:files.caption')}
    >
      {files.isError ? (
        <AlertBanner tone="danger">
          {t('imports:loadFailed')}{' '}
          <Button onClick={() => void files.refetch()}>{t('imports:retry')}</Button>
        </AlertBanner>
      ) : null}
      {files.isPending ? <Skeleton /> : null}
      {upload.isError || remove.isError ? (
        <AlertBanner tone="danger">{t('imports:files.failed')}</AlertBanner>
      ) : null}
      {inventory ? null : (
        <Box
          sx={{
            display: 'grid',
            gap: 3,
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          }}
        >
          <Field id={`${id}-format`} label={t('imports:files.format')}>
            <TextField
              id={`${id}-format`}
              select
              slotProps={{ select: { inputProps: { 'aria-label': t('imports:files.format') } } }}
              size="small"
              disabled={busy}
              value={format}
              onChange={(event) => setFormat(event.target.value === 'bundle' ? 'bundle' : 'csv')}
            >
              <MenuItem value="csv">{t('imports:files.csv')}</MenuItem>
              <MenuItem value="bundle">{t('imports:files.bundle')}</MenuItem>
            </TextField>
          </Field>
          {format === 'csv' ? (
            <Field id={`${id}-entity`} label={t('imports:files.entity')}>
              <TextField
                id={`${id}-entity`}
                select
                slotProps={{ select: { inputProps: { 'aria-label': t('imports:files.entity') } } }}
                size="small"
                disabled={busy}
                value={entity}
                onChange={(event) => setEntity(importEntitySchema.parse(event.target.value))}
              >
                {importEntitySchema.options.map((value) => (
                  <MenuItem key={value} value={value}>
                    {t(`imports:entities.${value}`)}
                  </MenuItem>
                ))}
              </TextField>
            </Field>
          ) : null}
        </Box>
      )}
      <Field id={`${id}-file`} label={t('imports:files.choose')} hint={t('imports:files.limit')}>
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          accept={
            !inventory && format === 'bundle'
              ? '.zip,application/zip'
              : '.csv,.tsv,text/csv,text/tab-separated-values'
          }
          disabled={busy}
          aria-describedby={`${id}-file-hint`}
          onChange={(event) => setFile(event.target.files?.item(0) ?? null)}
        />
      </Field>
      {file && (file.size === 0 || file.size > 2147483648) ? (
        <AlertBanner tone="warning">{t('imports:files.limit')}</AlertBanner>
      ) : null}
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button
          variant="outlined"
          startIcon={<Upload size={16} aria-hidden="true" />}
          disabled={
            busy || dirtyFiles.size > 0 || !file || file.size === 0 || file.size > 2147483648
          }
          onClick={() => upload.mutate()}
        >
          {t('imports:files.upload')}
        </Button>
        {upload.isPending ? (
          <Button onClick={() => controller.current?.abort()}>
            {t('imports:files.cancelUpload')}
          </Button>
        ) : null}
      </Box>
      {upload.isPending ? (
        <LinearProgress
          aria-label={t('imports:files.uploading')}
          {...(progress === null ? {} : { variant: 'determinate', value: progress })}
        />
      ) : null}
      <Box
        component="ul"
        sx={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}
      >
        {files.data?.files.map((source) => (
          <Box component="li" key={source.id} sx={{ display: 'grid', gap: 2 }}>
            <Box
              sx={{
                display: 'flex',
                gap: 3,
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                <bdi>{source.fileName}</bdi>
              </Typography>
              <Button
                startIcon={<X size={16} aria-hidden="true" />}
                disabled={busy}
                onClick={() => setRemoveId(source.id)}
                aria-label={t('imports:files.removeNamed', { name: source.fileName })}
              >
                {t('imports:files.remove')}
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary">
              {t('imports:files.metadata', {
                size: number.format(source.size),
                status: t(`imports:files.status.${source.status}`),
              })}
            </Typography>
            {source.status === 'invalid' ? (
              <AlertBanner tone="danger">
                {t('imports:files.invalid')}
                {source.inventoryMapping && source.error && /:\d+$/.test(source.error)
                  ? ` ${t('imports:inventory.invalidRow', { row: number.format(Number(source.error.split(':').at(-1))) })}`
                  : null}
              </AlertBanner>
            ) : null}
            {source.format === 'csv' &&
            source.status === 'ready' &&
            (source.inventoryMapping ? !source.inventoryMapping.idColumn : !source.hasMapping) ? (
              <AlertBanner tone="info">{t('imports:files.needsMapping')}</AlertBanner>
            ) : null}
            {source.format === 'csv' &&
            (source.status === 'ready' ||
              (source.status === 'invalid' && source.inventoryMapping && source.hasHeaders)) ? (
              <Button
                disabled={busy || (dirtyFiles.size > 0 && selectedFileId !== source.id)}
                onClick={() => setSelectedFileId(source.id)}
              >
                {t(
                  source.inventoryMapping
                    ? 'imports:inventory.mappingTitle'
                    : 'imports:columns.title',
                )}
              </Button>
            ) : null}
            {source.format === 'csv' &&
            (source.status === 'ready' ||
              (source.status === 'invalid' && source.inventoryMapping && source.hasHeaders)) &&
            source.id === selectedFileId &&
            selected.data ? (
              <ImportFileMapper
                brandId={brandId}
                runId={runId}
                file={selected.data}
                disabled={busy}
                onDirty={(dirty) =>
                  setDirtyFiles((previous) => {
                    const next = new Set(previous);
                    if (dirty) next.add(source.id);
                    else next.delete(source.id);
                    return next;
                  })
                }
                onBusy={(pending) =>
                  setBusyFiles((previous) => {
                    const next = new Set(previous);
                    if (pending) next.add(source.id);
                    else next.delete(source.id);
                    return next;
                  })
                }
              />
            ) : null}
            {source.id === selectedFileId && selected.isPending ? <Skeleton /> : null}
            {source.id === selectedFileId && selected.isError ? (
              <AlertBanner tone="danger">
                {t('imports:loadFailed')}{' '}
                <Button onClick={() => void selected.refetch()}>{t('imports:retry')}</Button>
              </AlertBanner>
            ) : null}
          </Box>
        ))}
      </Box>
      {(files.data?.files.length ?? 0) > 0 && !ready ? (
        <AlertBanner tone="info">{t('imports:files.notReady')}</AlertBanner>
      ) : null}
      <ConfirmDialog
        open={removeId !== null}
        title={t('imports:files.remove')}
        body={t('imports:files.removeBody')}
        confirmLabel={t('imports:files.remove')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (removeId) remove.mutate(removeId);
        }}
        onClose={() => setRemoveId(null)}
      />
    </SectionCard>
  );
}
