import { resources } from '@helpdock/i18n';
import type { ImportEntity } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { type FileColumnRule, fileDestinations } from '../../../imports/file-columns.js';
import { Field } from '../../../ui/field.js';
import { ImportFileTransforms } from './import-file-transforms.js';

export function ImportFileColumn({
  entity,
  headers,
  rule,
  firstCells,
  disabled,
  onChange,
  onDuplicate,
}: {
  entity: ImportEntity;
  headers: string[];
  rule: FileColumnRule;
  firstCells: string[];
  disabled: boolean;
  onChange: (next: FileColumnRule) => void;
  onDuplicate: () => void;
}) {
  const t = useT();
  const id = useId();
  const choices = fileDestinations(entity);
  const isCustom = rule.target.startsWith('custom.');
  if (rule.target && !choices.includes(rule.target) && !isCustom) choices.push(rule.target);
  const fieldLabel = (field: string): string => {
    const key = field as keyof typeof resources.en.imports.columns.fields;
    return Object.hasOwn(resources.en.imports.columns.fields, field)
      ? t(`imports:columns.fields.${key}`)
      : field;
  };
  const display = (target: string): string => {
    if (target.startsWith('firstMessage.'))
      return `${t('imports:columns.firstMessage')} · ${fieldLabel(target.slice('firstMessage.'.length))}`;
    if (target.endsWith('.en') || target.endsWith('.ar')) {
      const [name, locale] = target.split('.');
      return `${fieldLabel(name ?? target)} · ${locale === 'ar' ? t('imports:columns.arabic') : t('imports:columns.english')}`;
    }
    return fieldLabel(target);
  };
  const sample =
    rule.source.kind === 'columns'
      ? rule.source.names.map((name) => firstCells[headers.indexOf(name)] ?? '').join(' · ')
      : String(rule.source.value);
  const literal = rule.source.kind === 'literal';
  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      <Field id={`${id}-source-kind`} label={t('imports:columns.sourceKind')}>
        <TextField
          id={`${id}-source-kind`}
          select
          slotProps={{ select: { inputProps: { 'aria-label': t('imports:columns.sourceKind') } } }}
          size="small"
          disabled={disabled}
          value={literal ? 'literal' : 'columns'}
          onChange={(event) =>
            onChange({
              ...rule,
              source:
                event.target.value === 'literal'
                  ? { kind: 'literal', value: '' }
                  : { kind: 'columns', names: headers.slice(0, 1) },
            })
          }
        >
          <MenuItem value="columns">{t('imports:columns.sourceColumns')}</MenuItem>
          <MenuItem value="literal">{t('imports:columns.constant')}</MenuItem>
        </TextField>
      </Field>
      {rule.source.kind === 'columns' ? (
        <Field id={`${id}-columns`} label={t('imports:columns.column')}>
          <TextField
            id={`${id}-columns`}
            select
            size="small"
            disabled={disabled}
            value={rule.source.names}
            slotProps={{
              select: { multiple: true, inputProps: { 'aria-label': t('imports:columns.column') } },
            }}
            onChange={(event) => {
              const names = Array.isArray(event.target.value)
                ? event.target.value
                : [event.target.value];
              onChange({ ...rule, source: { kind: 'columns', names } });
            }}
          >
            {headers.map((header) => (
              <MenuItem key={header} value={header}>
                {header}
              </MenuItem>
            ))}
          </TextField>
        </Field>
      ) : (
        <Field
          id={`${id}-literal`}
          label={t('imports:columns.constant')}
          hint={t('imports:columns.constantHint')}
        >
          <TextField
            id={`${id}-literal`}
            size="small"
            disabled={disabled}
            value={
              typeof rule.source.value === 'string'
                ? rule.source.value
                : JSON.stringify(rule.source.value)
            }
            onChange={(event) =>
              onChange({ ...rule, source: { kind: 'literal', value: event.target.value } })
            }
          />
        </Field>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {t('imports:columns.firstValue')} <bdi>{sample}</bdi>
      </Typography>
      <Field id={`${id}-target`} label={t('imports:columns.destination')}>
        <TextField
          id={`${id}-target`}
          select
          slotProps={{ select: { inputProps: { 'aria-label': t('imports:columns.destination') } } }}
          size="small"
          disabled={disabled}
          value={isCustom ? '__custom' : rule.target}
          onChange={(event) =>
            onChange({
              ...rule,
              target: event.target.value === '__custom' ? 'custom.' : event.target.value,
            })
          }
        >
          <MenuItem value="">{t('imports:columns.skip')}</MenuItem>
          {choices.map((target) => (
            <MenuItem key={target} value={target}>
              {display(target)}
            </MenuItem>
          ))}
          {choices.includes('custom') ? (
            <MenuItem value="__custom">{t('imports:columns.customField')}</MenuItem>
          ) : null}
        </TextField>
      </Field>
      {isCustom ? (
        <Field id={`${id}-custom-key`} label={t('imports:columns.customKey')}>
          <TextField
            id={`${id}-custom-key`}
            size="small"
            disabled={disabled}
            value={rule.target.slice('custom.'.length)}
            onChange={(event) => onChange({ ...rule, target: `custom.${event.target.value}` })}
          />
        </Field>
      ) : null}
      {rule.target ? (
        <>
          <ImportFileTransforms
            value={rule.transforms}
            disabled={disabled}
            onChange={(transforms) => onChange({ ...rule, transforms })}
          />
          <FormControlLabel
            label={t('imports:columns.omitEmpty')}
            control={
              <Checkbox
                checked={rule.omitEmpty}
                disabled={disabled}
                onChange={(_event, omitEmpty) => onChange({ ...rule, omitEmpty })}
              />
            }
          />
        </>
      ) : null}
      <Button size="small" disabled={disabled} onClick={onDuplicate}>
        {t('imports:columns.duplicate')}
      </Button>
    </Box>
  );
}
