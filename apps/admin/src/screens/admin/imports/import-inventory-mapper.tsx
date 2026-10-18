import { type ImportInventoryMapping, importInventoryLocationSchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { type ImportFileView, importKeys } from '../../../imports/api.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.js';
import { Field } from '../../../ui/field.js';

/** The existing file-mapper pattern, narrowed to a source ID and archive location. */
export function ImportInventoryMapper({
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
  const t = useT();
  const { locale } = usePreferences();
  const api = useImportsApi();
  const cache = useQueryClient();
  const id = useId();
  const [idColumn, setIdColumn] = useState(file.inventoryMapping?.idColumn ?? '');
  const [location, setLocation] = useState<ImportInventoryMapping['location']>(
    file.inventoryMapping?.location ?? 'auto',
  );
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.mapInventory(brandId, runId, file.id, { idColumn: idColumn || null, location }),
    onMutate: async () => {
      onBusy(true);
      await cache.cancelQueries({ queryKey: importKeys.files(brandId, runId) });
    },
    onSuccess: async () => {
      setDirty(false);
      onDirty(false);
      await cache.invalidateQueries({ queryKey: importKeys.files(brandId, runId) });
    },
    onSettled: () => onBusy(false),
  });
  const changed = () => {
    setDirty(true);
    onDirty(true);
  };
  const column = file.headers?.indexOf(idColumn) ?? -1;
  const busy = disabled || save.isPending;
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      <Typography component="h3" variant="h3">
        {t('imports:inventory.mappingTitle')}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t('imports:inventory.mappingHint')}
      </Typography>
      {save.isError ? (
        <AlertBanner tone="danger">{t('imports:columns.saveFailed')}</AlertBanner>
      ) : null}
      <Field id={`${id}-column`} label={t('imports:inventory.idColumn')}>
        <TextField
          id={`${id}-column`}
          select
          size="small"
          value={idColumn}
          slotProps={{ select: { inputProps: { 'aria-label': t('imports:inventory.idColumn') } } }}
          disabled={busy}
          onChange={(event) => {
            setIdColumn(event.target.value);
            changed();
          }}
        >
          <MenuItem value="">{t('imports:inventory.chooseColumn')}</MenuItem>
          {file.headers?.map((header) => (
            <MenuItem key={header} value={header}>
              <bdi>{header}</bdi>
            </MenuItem>
          ))}
        </TextField>
      </Field>
      <Field id={`${id}-location`} label={t('imports:inventory.location')}>
        <TextField
          id={`${id}-location`}
          select
          size="small"
          value={location}
          slotProps={{ select: { inputProps: { 'aria-label': t('imports:inventory.location') } } }}
          disabled={busy}
          onChange={(event) => {
            setLocation(importInventoryLocationSchema.parse(event.target.value));
            changed();
          }}
        >
          {importInventoryLocationSchema.options.map((value) => (
            <MenuItem key={value} value={value}>
              {t(`imports:inventory.locations.${value}`)}
            </MenuItem>
          ))}
        </TextField>
      </Field>
      <Button
        variant="outlined"
        disabled={busy || !dirty || column < 0}
        onClick={() => save.mutate()}
        sx={{ justifySelf: 'start' }}
      >
        {t('imports:inventory.save')}
      </Button>
      {dirty ? (
        <AlertBanner tone="info">{t('imports:columns.previewStale')}</AlertBanner>
      ) : file.inventoryValidation ? (
        <Typography role="status" variant="body2">
          {t('imports:inventory.validated', {
            records: number.format(file.inventoryValidation.records),
            duplicates: number.format(file.inventoryValidation.duplicates),
          })}
        </Typography>
      ) : file.status === 'ready' && file.inventoryMapping?.idColumn ? (
        <Typography role="status">{t('imports:columns.validating')}</Typography>
      ) : null}
      {column >= 0 ? (
        <TableContainer>
          <Table size="small" aria-label={t('imports:inventory.preview')}>
            <TableHead>
              <TableRow>
                <TableCell>{t('imports:columns.row')}</TableCell>
                <TableCell>{t('imports:inventory.idColumn')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {file.sampleRows?.map((row) => (
                <TableRow key={row.line}>
                  <TableCell>{number.format(row.line)}</TableCell>
                  <TableCell sx={{ overflowWrap: 'anywhere' }}>
                    <bdi>{row.cells[column] ?? '—'}</bdi>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        {t('imports:inventory.previewHint')}
      </Typography>
    </Box>
  );
}
