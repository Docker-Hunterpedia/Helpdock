import {
  type ImportMapping,
  type ImportMappingValue,
  importMappingKindSchema,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  MenuItem,
  Skeleton,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { importKeys } from '../../../imports/api.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { Field } from '../../../ui/field.js';
import { SectionCard } from '../channels/section-card.tsx';
import { ImportMappingPicker } from './import-mapping-picker.js';
import { ImportInvitedPerson, ImportNewField } from './import-mapping-special.js';

export function ImportMappings({
  brandId,
  runId,
  disabled,
  onDirty,
  onSaved,
}: {
  brandId: string;
  runId: string;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [kind, setKind] = useState<ImportMapping['kind']>('status');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [dirty, setDirty] = useState(false);
  const after = cursors.at(-1);
  const updateDirty = (value: boolean) => {
    setDirty(value);
    onDirty(value);
  };
  return (
    <SectionCard
      id="import-mappings"
      heading={t('imports:mapping.title')}
      caption={t('imports:mapping.caption')}
    >
      <Tabs
        value={kind}
        variant="scrollable"
        scrollButtons="auto"
        aria-label={t('imports:mapping.title')}
        onChange={(_event, next: ImportMapping['kind']) => {
          setKind(next);
          setCursors([undefined]);
        }}
      >
        {importMappingKindSchema.options.map((entry) => (
          <Tab
            id={`import-map-${entry}`}
            aria-controls="import-mapping-panel"
            key={entry}
            value={entry}
            disabled={disabled || dirty}
            label={t(`imports:mapping.kinds.${entry}`)}
          />
        ))}
      </Tabs>
      <Box id="import-mapping-panel" role="tabpanel" aria-labelledby={`import-map-${kind}`}>
        <MappingPage
          key={`${kind}:${after === undefined ? 'first' : `after:${after}`}`}
          brandId={brandId}
          runId={runId}
          kind={kind}
          after={after}
          disabled={disabled}
          hasPrevious={cursors.length > 1}
          onPrevious={() => setCursors((previous) => previous.slice(0, -1))}
          onNext={(cursor) => setCursors((previous) => [...previous, cursor])}
          onDirty={updateDirty}
          onSaved={onSaved}
        />
      </Box>
    </SectionCard>
  );
}

function MappingPage({
  brandId,
  runId,
  kind,
  after,
  disabled,
  hasPrevious,
  onPrevious,
  onNext,
  onDirty,
  onSaved,
}: {
  brandId: string;
  runId: string;
  kind: ImportMapping['kind'];
  after: string | undefined;
  disabled: boolean;
  hasPrevious: boolean;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
  onDirty: (dirty: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const api = useImportsApi();
  const t = useT();
  const cache = useQueryClient();
  const { locale } = usePreferences();
  const [edits, setEdits] = useState<Map<string, ImportMapping | null>>(new Map());
  const [resetKey, setResetKey] = useState(0);
  const query = { kind, limit: 50, ...(after === undefined ? {} : { after }) };
  const values = useQuery({
    queryKey: importKeys.mappingValues(brandId, runId, query),
    queryFn: () => api.mappingValues(brandId, runId, query),
    refetchOnWindowFocus: false,
    enabled: !disabled,
  });
  const dirty = edits.size > 0;
  const mappings = (values.data?.values ?? [])
    .map((source) =>
      edits.has(source.externalValue)
        ? (edits.get(source.externalValue) ?? null)
        : (source.confirmed ?? source.proposed),
    )
    .filter((mapping): mapping is ImportMapping => mapping !== null);
  const incompleteEdit = [...edits.values()].some((value) => value === null);
  const save = useMutation({
    mutationFn: () => api.updateMappings(brandId, runId, { mappings }),
    onMutate: () => onDirty(true),
    onError: () => onDirty(edits.size > 0),
    onSuccess: async () => {
      // Remove the previous receipt before refreshing any view that can start the import.
      cache.removeQueries({ queryKey: importKeys.report(brandId, runId) });
      await values.refetch();
      await onSaved();
      setEdits(new Map());
      setResetKey((previous) => previous + 1);
      onDirty(false);
    },
  });
  const busy = disabled || save.isPending;
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  if (values.isError)
    return (
      <AlertBanner tone="danger">
        {t('imports:loadFailed')}{' '}
        <Button onClick={() => void values.refetch()}>{t('imports:retry')}</Button>
      </AlertBanner>
    );
  if (!values.data) return <Skeleton />;
  return (
    <Box sx={{ display: 'grid', gap: 4 }}>
      {save.isError ? (
        <AlertBanner tone="danger">{t('imports:mapping.saveFailed')}</AlertBanner>
      ) : null}
      {!values.data.values.length ? (
        <Typography color="text.secondary">{t('imports:mapping.empty')}</Typography>
      ) : (
        <TableContainer>
          <Table size="small" aria-label={t(`imports:mapping.kinds.${kind}`)}>
            <TableHead>
              <TableRow>
                <TableCell>{t('imports:mapping.source')}</TableCell>
                <TableCell>{t('imports:mapping.count')}</TableCell>
                <TableCell>{t('imports:mapping.destination')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {values.data.values.map((source) => (
                <TableRow key={`${resetKey}:${source.externalValue}`}>
                  <TableCell component="th" scope="row" sx={{ overflowWrap: 'anywhere' }}>
                    <Typography>
                      <bdi>{source.label || t('imports:mapping.missing')}</bdi>
                    </Typography>
                    {source.person?.email ? (
                      <Typography variant="caption">
                        <bdi>{source.person.email}</bdi>
                      </Typography>
                    ) : null}
                    {source.label !== source.externalValue ? (
                      <Typography variant="caption" color="text.secondary">
                        <bdi>{source.externalValue}</bdi>
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <bdi dir="ltr">
                      {source.occurrences === null ? '—' : number.format(source.occurrences)}
                    </bdi>
                  </TableCell>
                  <TableCell>
                    <MappingRow
                      brandId={brandId}
                      runId={runId}
                      kind={kind}
                      source={source}
                      value={
                        edits.has(source.externalValue)
                          ? (edits.get(source.externalValue) ?? null)
                          : (source.confirmed ?? source.proposed)
                      }
                      disabled={busy}
                      onChange={(mapping) => {
                        setEdits((previous) =>
                          new Map(previous).set(source.externalValue, mapping),
                        );
                        onDirty(true);
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'flex-end' }}>
        <Button
          disabled={busy || !dirty}
          onClick={() => {
            setEdits(new Map());
            setResetKey((previous) => previous + 1);
            onDirty(false);
          }}
        >
          {t('imports:mapping.discard')}
        </Button>
        <Button disabled={busy || dirty || !hasPrevious} onClick={onPrevious}>
          {t('imports:mapping.previous')}
        </Button>
        <Button
          disabled={busy || dirty || values.data.nextCursor === null}
          onClick={() => {
            if (values.data.nextCursor !== null) onNext(values.data.nextCursor);
          }}
        >
          {t('imports:mapping.next')}
        </Button>
        <Button
          variant="contained"
          disabled={busy || !mappings.length || incompleteEdit}
          onClick={() => save.mutate()}
        >
          {t('imports:mapping.save')}
        </Button>
      </Box>
      {dirty ? (
        <Typography role="status" variant="caption">
          {t('imports:mapping.unsaved')}
        </Typography>
      ) : null}
    </Box>
  );
}

function MappingRow({
  brandId,
  runId,
  kind,
  source,
  value,
  disabled,
  onChange,
}: {
  brandId: string;
  runId: string;
  kind: ImportMapping['kind'];
  source: ImportMappingValue;
  value: ImportMapping | null;
  disabled: boolean;
  onChange: (mapping: ImportMapping | null) => void;
}) {
  const t = useT();
  const id = useId();
  const initialMode =
    value?.kind === 'agent' && value.target.kind !== 'existing'
      ? value.target.kind
      : value?.kind === 'field' && value.target.kind !== 'existing'
        ? value.target.kind
        : value?.kind === 'tag' && value.target.tagId === null
          ? 'skip'
          : 'existing';
  const [mode, setMode] = useState<string>(initialMode);
  const special = ['agent', 'field', 'tag'].includes(kind);
  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      {special ? (
        <Field id={id} label={t('imports:mapping.action')}>
          <TextField
            id={id}
            select
            size="small"
            disabled={disabled}
            value={mode}
            onChange={(event) => {
              const next = event.target.value;
              setMode(next);
              if (kind === 'agent' && next === 'name')
                onChange({ kind, externalValue: source.externalValue, target: { kind: 'name' } });
              else if (kind === 'field' && next === 'skip')
                onChange({ kind, externalValue: source.externalValue, target: { kind: 'skip' } });
              else if (kind === 'tag' && next === 'skip')
                onChange({ kind, externalValue: source.externalValue, target: { tagId: null } });
              else onChange(null);
            }}
          >
            <MenuItem value="existing">{t('imports:mapping.existing')}</MenuItem>
            {kind === 'agent' ? (
              <MenuItem value="name">{t('imports:mapping.nameOnly')}</MenuItem>
            ) : (
              <MenuItem value="skip">{t('imports:mapping.skip')}</MenuItem>
            )}
            {kind === 'agent' ? (
              <MenuItem value="invited" disabled={!source.person?.email}>
                {t('imports:mapping.invited')}
              </MenuItem>
            ) : null}
            {kind === 'field' ? (
              <MenuItem value="create">{t('imports:mapping.createField')}</MenuItem>
            ) : null}
          </TextField>
        </Field>
      ) : null}
      {mode === 'existing' ? (
        <ImportMappingPicker
          brandId={brandId}
          runId={runId}
          source={source}
          kind={kind}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
      {mode === 'invited' ? (
        <ImportInvitedPerson
          brandId={brandId}
          source={source}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
      {mode === 'create' ? (
        <ImportNewField
          brandId={brandId}
          runId={runId}
          source={source}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
      {!source.confirmed && source.proposed ? (
        <Typography variant="caption" color="text.secondary">
          {t('imports:mapping.proposed')}
        </Typography>
      ) : null}
    </Box>
  );
}
