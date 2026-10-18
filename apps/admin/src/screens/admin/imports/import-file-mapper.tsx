import { importFilePresetCreateSchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Skeleton,
  TextField,
  Typography,
} from '@mui/material';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { type ImportFileView, importKeys } from '../../../imports/api.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { compileFileColumns, initialFileColumns } from '../../../imports/file-columns.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.js';
import { ImportFileColumn } from './import-file-column.js';
import { ImportFilePreview } from './import-file-preview.js';
import { ImportInventoryMapper } from './import-inventory-mapper.js';

export function ImportFileMapper({
  brandId,
  runId,
  file,
  disabled,
  onDirty,
  onBusy,
}: {
  brandId: string;
  runId: string;
  file: ImportFileView;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  if (file.inventoryMapping)
    return (
      <ImportInventoryMapper
        brandId={brandId}
        runId={runId}
        file={file}
        disabled={disabled}
        onDirty={onDirty}
        onBusy={onBusy}
      />
    );
  if (!file.headers || !file.entity) return null;
  return (
    <FileMapper
      brandId={brandId}
      runId={runId}
      file={file}
      headers={file.headers}
      entity={file.entity}
      disabled={disabled}
      onDirty={onDirty}
      onBusy={onBusy}
    />
  );
}

function FileMapper({
  brandId,
  runId,
  file,
  headers,
  entity,
  disabled,
  onDirty,
  onBusy,
}: Parameters<typeof ImportFileMapper>[0] & {
  headers: string[];
  entity: NonNullable<ImportFileView['entity']>;
}) {
  const t = useT();
  const api = useImportsApi();
  const cache = useQueryClient();
  const id = useId();
  const [rules, setRules] = useState(() => initialFileColumns(entity, headers, file.mapping));
  const [dirty, setDirty] = useState(false);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [skipInvalidRows, setSkipInvalidRows] = useState(file.mapping?.skipInvalidRows ?? false);
  const [page, setPage] = useState(0);
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(rules.length / 20) - 1));
  const parsed = compileFileColumns(entity, rules, skipInvalidRows);
  const presets = useInfiniteQuery({
    queryKey: [...importKeys.presets(brandId), entity, file.headerFingerprint],
    queryFn: ({ pageParam }) =>
      api.presets(brandId, {
        entity,
        ...(file.headerFingerprint ? { headerFingerprint: file.headerFingerprint } : {}),
        ...(pageParam ? { after: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: file.headerFingerprint !== null,
  });
  const matchingPresets = presets.data?.pages.flatMap((page) => page.presets) ?? [];
  const consideredPreset = useRef(false);
  useEffect(() => {
    if (!presets.data || consideredPreset.current) return;
    consideredPreset.current = true;
    const matches = presets.data.pages.flatMap((result) => result.presets);
    if (file.mapping || dirty || matches.length !== 1 || presets.hasNextPage) return;
    const match = matches[0];
    if (!match) return;
    setRules(initialFileColumns(entity, headers, match.mapping));
    setSkipInvalidRows(match.mapping.skipInvalidRows ?? false);
    setPresetId(match.id);
    setDirty(true);
    onDirty(true);
  }, [presets.data, presets.hasNextPage, file.mapping, dirty, entity, headers, onDirty]);
  const refresh = () => cache.invalidateQueries({ queryKey: importKeys.files(brandId, runId) });
  const save = useMutation({
    mutationFn: async () => {
      if (!parsed.success) throw new Error('import.file-mapping-invalid');
      return api.mapFile(brandId, runId, file.id, parsed.data);
    },
    onMutate: () => onBusy(true),
    onSuccess: async () => {
      await refresh();
      setDirty(false);
      onDirty(false);
    },
    onSettled: () => onBusy(false),
  });
  const preset = useMutation({
    mutationFn: async () => {
      if (!parsed.success) throw new Error('import.file-mapping-invalid');
      return api.savePreset(
        brandId,
        importFilePresetCreateSchema.parse({ name: presetName, headers, mapping: parsed.data }),
      );
    },
    onSuccess: async () => {
      setPresetName('');
      await cache.invalidateQueries({ queryKey: importKeys.presets(brandId) });
    },
  });
  const markDirty = () => {
    setDirty(true);
    onDirty(true);
  };
  const busy = disabled || save.isPending || preset.isPending;
  return (
    <Box sx={{ display: 'grid', gap: 4 }}>
      <Typography component="h3" variant="h3">
        {t('imports:columns.title')}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t('imports:columns.caption')}
      </Typography>
      {save.isError || preset.isError ? (
        <AlertBanner tone="danger">{t('imports:columns.saveFailed')}</AlertBanner>
      ) : null}
      {presets.isError ? (
        <AlertBanner tone="warning">
          {t('imports:columns.presetsFailed')}{' '}
          <Button onClick={() => void presets.refetch()}>{t('imports:retry')}</Button>
        </AlertBanner>
      ) : null}
      {presets.isFetching && !presets.data ? <Skeleton /> : null}
      <Field id={`${id}-preset`} label={t('imports:columns.preset')}>
        <TextField
          id={`${id}-preset`}
          select
          slotProps={{ select: { inputProps: { 'aria-label': t('imports:columns.preset') } } }}
          size="small"
          disabled={busy}
          value={presetId}
          onChange={(event) => {
            const selected = matchingPresets.find((item) => item.id === event.target.value);
            setPresetId(event.target.value);
            if (selected) {
              setRules(initialFileColumns(entity, headers, selected.mapping));
              setSkipInvalidRows(selected.mapping.skipInvalidRows ?? false);
              markDirty();
            }
          }}
        >
          <MenuItem value="">{t('imports:columns.choosePreset')}</MenuItem>
          {matchingPresets.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.name}
            </MenuItem>
          ))}
        </TextField>
      </Field>
      {presets.hasNextPage ? (
        <Button
          disabled={busy || presets.isFetchingNextPage}
          onClick={() => void presets.fetchNextPage()}
        >
          {t('imports:columns.morePresets')}
        </Button>
      ) : null}
      {rules.slice(pageIndex * 20, (pageIndex + 1) * 20).map((rule) => (
        <Box key={rule.id} sx={{ paddingBlock: 3 }}>
          <ImportFileColumn
            entity={entity}
            headers={headers}
            rule={rule}
            firstCells={file.sampleRows?.[0]?.cells ?? []}
            disabled={busy}
            onChange={(next) => {
              setRules((previous) => previous.map((item) => (item.id === rule.id ? next : item)));
              markDirty();
            }}
            onDuplicate={() => {
              setRules((previous) => [
                ...previous,
                { ...rule, id: crypto.randomUUID(), target: '' },
              ]);
              markDirty();
            }}
          />
          <Button
            size="small"
            disabled={busy}
            onClick={() => {
              setRules((previous) => previous.filter((item) => item.id !== rule.id));
              markDirty();
            }}
          >
            {t('imports:columns.removeRule')}
          </Button>
        </Box>
      ))}
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button disabled={busy || pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>
          {t('imports:mapping.previous')}
        </Button>
        <Button
          disabled={busy || (pageIndex + 1) * 20 >= rules.length}
          onClick={() => setPage(pageIndex + 1)}
        >
          {t('imports:mapping.next')}
        </Button>
      </Box>
      <Button
        disabled={busy || rules.length >= 500}
        onClick={() => {
          setRules((previous) => [
            ...previous,
            {
              id: crypto.randomUUID(),
              target: '',
              source: { kind: 'literal', value: '' },
              transforms: [],
              omitEmpty: true,
            },
          ]);
          markDirty();
        }}
      >
        {t('imports:columns.addRule')}
      </Button>
      {!parsed.success ? (
        <AlertBanner tone="warning">{t('imports:columns.invalidMapping')}</AlertBanner>
      ) : null}
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Button
          disabled={busy || !dirty}
          onClick={() => {
            setRules(initialFileColumns(entity, headers, file.mapping));
            setSkipInvalidRows(file.mapping?.skipInvalidRows ?? false);
            setDirty(false);
            onDirty(false);
          }}
        >
          {t('imports:mapping.discard')}
        </Button>
        <Button
          variant="contained"
          disabled={busy || !parsed.success || (!dirty && file.mapping !== null)}
          onClick={() => save.mutate()}
        >
          {t('imports:columns.validate')}
        </Button>
      </Box>
      <ImportFilePreview file={file} stale={dirty} />
      <FormControlLabel
        label={t('imports:columns.skipInvalidRows')}
        control={
          <Checkbox
            checked={skipInvalidRows}
            disabled={busy}
            onChange={(_event, checked) => {
              setSkipInvalidRows(checked);
              markDirty();
            }}
          />
        }
      />
      <Field id={`${id}-name`} label={t('imports:columns.presetName')}>
        <TextField
          id={`${id}-name`}
          size="small"
          disabled={busy}
          value={presetName}
          onChange={(event) => setPresetName(event.target.value)}
        />
      </Field>
      <Button
        disabled={busy || !parsed.success || !presetName.trim() || presetName.trim().length > 80}
        onClick={() => preset.mutate()}
      >
        {t('imports:columns.savePreset')}
      </Button>
      {preset.isSuccess ? (
        <Typography role="status" variant="caption">
          {t('imports:columns.presetSaved')}
        </Typography>
      ) : null}
    </Box>
  );
}
