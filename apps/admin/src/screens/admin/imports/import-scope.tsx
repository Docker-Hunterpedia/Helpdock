import {
  FRESHDESK_IMPORT_ENTITIES,
  type ImportEntity,
  type ImportRunView,
  importEntitySchema,
  importRequiresTicketInventory,
  ZOHODESK_IMPORT_ENTITIES,
} from '@helpdock/schemas';
import { Box, Button, Checkbox, FormControlLabel, MenuItem, TextField } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.js';
import { SectionCard } from '../channels/section-card.tsx';

export function ImportScope({
  run,
  onExtracting,
  disabled = false,
  inventoryReady = false,
  inventoryRevision = '',
  onInventorySelection,
}: {
  run: ImportRunView;
  onExtracting: (run: ImportRunView) => void;
  disabled?: boolean;
  inventoryReady?: boolean;
  inventoryRevision?: string;
  onInventorySelection?: (selected: boolean) => void;
}) {
  const t = useT();
  const api = useImportsApi();
  const [entities, setEntities] = useState<ImportEntity[]>(run.scope.entities);
  const [rebuildAllReports, setRebuildAllReports] = useState(run.scope.rebuildAllReports);
  const [inventoryMode, setInventoryMode] = useState<'archives' | 'complete'>(
    run.scope.inventoryMode ?? 'archives',
  );
  const [inventoryConfirmed, setInventoryConfirmed] = useState(
    run.scope.inventoryConfirmed ?? false,
  );
  const [useTicketInventory, setUseTicketInventory] = useState(
    run.scope.useTicketInventory ?? false,
  );
  const lastInventoryRevision = useRef(inventoryRevision);
  useEffect(() => {
    if (lastInventoryRevision.current !== inventoryRevision) {
      lastInventoryRevision.current = inventoryRevision;
      setInventoryConfirmed(false);
    }
  }, [inventoryRevision]);
  const inventoryRequired = importRequiresTicketInventory(run.source, {
    entities,
    rebuildAllReports,
    useTicketInventory,
  });
  const availableEntities =
    run.source === 'freshdesk'
      ? FRESHDESK_IMPORT_ENTITIES
      : run.source === 'zohodesk'
        ? ZOHODESK_IMPORT_ENTITIES
        : importEntitySchema.options;
  const extract = useMutation({
    mutationFn: async () => {
      await api.scope(run.brandId, run.id, {
        entities,
        rebuildAllReports,
        ...(run.source === 'zohodesk' ? { useTicketInventory } : {}),
        ...(inventoryRequired ? { inventoryMode, inventoryConfirmed } : {}),
      });
      return api.extract(run.brandId, run.id);
    },
    onSuccess: (run) => onExtracting(run),
  });
  return (
    <SectionCard
      id="import-scope"
      heading={t('imports:scope.title')}
      caption={t('imports:scope.caption')}
      footer={
        <Button
          variant="contained"
          disabled={
            disabled ||
            extract.isPending ||
            entities.length === 0 ||
            (inventoryRequired && (!inventoryReady || !inventoryConfirmed))
          }
          onClick={() => extract.mutate()}
        >
          {t('imports:scope.extract')}
        </Button>
      }
    >
      {extract.isError ? (
        <AlertBanner tone="danger">{t('imports:scope.failed')}</AlertBanner>
      ) : null}
      <Box
        component="fieldset"
        disabled={extract.isPending}
        sx={{ border: 0, margin: 0, padding: 0 }}
      >
        <legend>{t('imports:scope.include')}</legend>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 2,
          }}
        >
          {availableEntities.map((entity) => (
            <FormControlLabel
              key={entity}
              label={t(`imports:entities.${entity}`)}
              control={
                <Checkbox
                  checked={entities.includes(entity)}
                  onChange={(_, checked) =>
                    setEntities((previous) =>
                      checked
                        ? [...previous, entity]
                        : previous.filter((entry) => entry !== entity),
                    )
                  }
                />
              }
            />
          ))}
        </Box>
      </Box>
      {run.source === 'zohodesk' ? (
        <>
          <AlertBanner tone="info">{t('imports:inventory.zohoAutomaticHint')}</AlertBanner>
          <FormControlLabel
            label={t('imports:inventory.useFallback')}
            control={
              <Checkbox
                checked={useTicketInventory}
                disabled={disabled || extract.isPending}
                onChange={(_, checked) => {
                  setUseTicketInventory(checked);
                  setInventoryConfirmed(false);
                  onInventorySelection?.(checked);
                }}
              />
            }
          />
        </>
      ) : null}
      {inventoryRequired ? (
        <>
          <Field id="import-inventory-mode" label={t('imports:inventory.mode')}>
            <TextField
              id="import-inventory-mode"
              slotProps={{ select: { inputProps: { 'aria-label': t('imports:inventory.mode') } } }}
              select
              size="small"
              value={inventoryMode}
              disabled={extract.isPending}
              onChange={(event) => {
                setInventoryMode(event.target.value === 'complete' ? 'complete' : 'archives');
                setInventoryConfirmed(false);
              }}
            >
              <MenuItem value="archives">{t('imports:inventory.modes.archives')}</MenuItem>
              <MenuItem value="complete">{t('imports:inventory.modes.complete')}</MenuItem>
            </TextField>
          </Field>
          <AlertBanner tone="info">{t('imports:inventory.modeHint')}</AlertBanner>
          <FormControlLabel
            label={t('imports:inventory.confirm')}
            control={
              <Checkbox
                checked={inventoryConfirmed}
                disabled={extract.isPending || !inventoryReady}
                onChange={(_, checked) => setInventoryConfirmed(checked)}
              />
            }
          />
        </>
      ) : null}
      <FormControlLabel
        label={t('imports:scope.reports')}
        control={
          <Checkbox
            checked={rebuildAllReports}
            disabled={extract.isPending}
            onChange={(_, checked) => setRebuildAllReports(checked)}
          />
        }
      />
      <AlertBanner tone="info">{t('imports:scope.numbers')}</AlertBanner>
    </SectionCard>
  );
}
