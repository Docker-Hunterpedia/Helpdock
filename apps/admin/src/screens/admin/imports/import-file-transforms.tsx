import type { ImportFileTransform } from '@helpdock/schemas';
import { Box, Button, MenuItem, TextField } from '@mui/material';
import { useId, useRef } from 'react';
import { useT } from '../../../app/i18n.js';
import { Field } from '../../../ui/field.js';

const KINDS = [
  'trim',
  'number',
  'json',
  'split',
  'join',
  'name',
  'date',
  'boolean',
  'values',
  'attachment-urls',
] as const;
function defaultTransform(kind: ImportFileTransform['kind']): ImportFileTransform {
  switch (kind) {
    case 'trim':
    case 'number':
    case 'json':
      return { kind };
    case 'split':
    case 'attachment-urls':
      return { kind, separator: ';' };
    case 'join':
      return { kind, separator: ' ' };
    case 'name':
      return { kind, part: 'given' };
    case 'date':
      return { kind, format: 'iso', timezone: 'UTC' };
    case 'boolean':
      return { kind, trueValues: ['true'], falseValues: ['false'] };
    case 'values':
      return { kind, entries: [] };
  }
}

export function ImportFileTransforms({
  value,
  disabled,
  onChange,
}: {
  value: ImportFileTransform[];
  disabled: boolean;
  onChange: (value: ImportFileTransform[]) => void;
}) {
  const t = useT();
  const id = useId();
  const keys = useRef(new WeakMap<object, string>());
  const keyOf = (entry: object) => {
    const existing = keys.current.get(entry);
    if (existing) return existing;
    const key = crypto.randomUUID();
    keys.current.set(entry, key);
    return key;
  };
  const update = (index: number, next: ImportFileTransform) => {
    const previous = value[index];
    if (previous) keys.current.set(next, keyOf(previous));
    onChange(value.map((item, position) => (position === index ? next : item)));
  };
  const updateEntry = (
    index: number,
    transform: Extract<ImportFileTransform, { kind: 'values' }>,
    position: number,
    next: (typeof transform.entries)[number],
  ) => {
    const previous = transform.entries[position];
    if (previous) keys.current.set(next, keyOf(previous));
    update(index, {
      ...transform,
      entries: transform.entries.map((entry, current) => (current === position ? next : entry)),
    });
  };
  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      {value.map((transform, index) => (
        <Box key={keyOf(transform)} sx={{ display: 'grid', gap: 2 }}>
          <Field id={`${id}-${index}-kind`} label={t('imports:columns.transform')}>
            <TextField
              id={`${id}-${index}-kind`}
              select
              slotProps={{
                select: { inputProps: { 'aria-label': t('imports:columns.transform') } },
              }}
              size="small"
              disabled={disabled}
              value={transform.kind}
              onChange={(event) => {
                const kind = KINDS.find((candidate) => candidate === event.target.value);
                if (kind) update(index, defaultTransform(kind));
              }}
            >
              {KINDS.map((kind) => (
                <MenuItem key={kind} value={kind}>
                  {t(`imports:columns.transforms.${kind}`)}
                </MenuItem>
              ))}
            </TextField>
          </Field>
          {'separator' in transform ? (
            <Field id={`${id}-${index}-separator`} label={t('imports:columns.separator')}>
              <TextField
                id={`${id}-${index}-separator`}
                size="small"
                disabled={disabled}
                value={transform.separator}
                onChange={(event) => update(index, { ...transform, separator: event.target.value })}
              />
            </Field>
          ) : null}
          {transform.kind === 'name' ? (
            <Field id={`${id}-${index}-part`} label={t('imports:columns.namePart')}>
              <TextField
                id={`${id}-${index}-part`}
                select
                slotProps={{
                  select: { inputProps: { 'aria-label': t('imports:columns.namePart') } },
                }}
                size="small"
                disabled={disabled}
                value={transform.part}
                onChange={(event) =>
                  update(index, {
                    ...transform,
                    part: event.target.value === 'family' ? 'family' : 'given',
                  })
                }
              >
                <MenuItem value="given">{t('imports:columns.given')}</MenuItem>
                <MenuItem value="family">{t('imports:columns.family')}</MenuItem>
              </TextField>
            </Field>
          ) : null}
          {transform.kind === 'date' ? (
            <>
              <Field id={`${id}-${index}-format`} label={t('imports:columns.dateFormat')}>
                <TextField
                  id={`${id}-${index}-format`}
                  select
                  slotProps={{
                    select: { inputProps: { 'aria-label': t('imports:columns.dateFormat') } },
                  }}
                  size="small"
                  disabled={disabled}
                  value={transform.format}
                  onChange={(event) => {
                    const format = (
                      ['iso', 'dmy', 'mdy', 'epoch-seconds', 'epoch-milliseconds'] as const
                    ).find((candidate) => candidate === event.target.value);
                    if (format) update(index, { ...transform, format });
                  }}
                >
                  {(['iso', 'dmy', 'mdy', 'epoch-seconds', 'epoch-milliseconds'] as const).map(
                    (format) => (
                      <MenuItem key={format} value={format}>
                        {t(`imports:columns.dateFormats.${format}`)}
                      </MenuItem>
                    ),
                  )}
                </TextField>
              </Field>
              <Field id={`${id}-${index}-zone`} label={t('imports:columns.timezone')}>
                <TextField
                  id={`${id}-${index}-zone`}
                  size="small"
                  disabled={disabled}
                  value={transform.timezone}
                  onChange={(event) =>
                    update(index, { ...transform, timezone: event.target.value })
                  }
                />
              </Field>
            </>
          ) : null}
          {transform.kind === 'boolean' ? (
            <>
              <Field id={`${id}-${index}-true`} label={t('imports:columns.trueValues')}>
                <TextField
                  id={`${id}-${index}-true`}
                  multiline
                  minRows={2}
                  size="small"
                  disabled={disabled}
                  value={transform.trueValues.join('\n')}
                  onChange={(event) =>
                    update(index, { ...transform, trueValues: event.target.value.split('\n') })
                  }
                />
              </Field>
              <Field id={`${id}-${index}-false`} label={t('imports:columns.falseValues')}>
                <TextField
                  id={`${id}-${index}-false`}
                  multiline
                  minRows={2}
                  size="small"
                  disabled={disabled}
                  value={transform.falseValues.join('\n')}
                  onChange={(event) =>
                    update(index, { ...transform, falseValues: event.target.value.split('\n') })
                  }
                />
              </Field>
            </>
          ) : null}
          {transform.kind === 'values' ? (
            <Box sx={{ display: 'grid', gap: 2 }}>
              {transform.entries.map((entry, position) => (
                <Box key={keyOf(entry)} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  <Field
                    id={`${id}-${index}-${position}-from`}
                    label={t('imports:columns.fromValue')}
                  >
                    <TextField
                      id={`${id}-${index}-${position}-from`}
                      size="small"
                      disabled={disabled}
                      value={entry.from}
                      onChange={(event) =>
                        updateEntry(index, transform, position, {
                          ...entry,
                          from: event.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field id={`${id}-${index}-${position}-to`} label={t('imports:columns.toValue')}>
                    <TextField
                      id={`${id}-${index}-${position}-to`}
                      size="small"
                      disabled={disabled}
                      value={entry.to}
                      onChange={(event) =>
                        updateEntry(index, transform, position, {
                          ...entry,
                          to: event.target.value,
                        })
                      }
                    />
                  </Field>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      update(index, {
                        ...transform,
                        entries: transform.entries.filter((_item, current) => current !== position),
                      })
                    }
                  >
                    {t('imports:columns.removeValue')}
                  </Button>
                </Box>
              ))}
              <Button
                disabled={disabled || transform.entries.length >= 1000}
                onClick={() =>
                  update(index, {
                    ...transform,
                    entries: [...transform.entries, { from: '', to: '' }],
                  })
                }
              >
                {t('imports:columns.addValue')}
              </Button>
            </Box>
          ) : null}
          <Button
            disabled={disabled}
            onClick={() => onChange(value.filter((_item, position) => position !== index))}
          >
            {t('imports:columns.removeTransform')}
          </Button>
        </Box>
      ))}
      <Button
        size="small"
        disabled={disabled || value.length >= 10}
        onClick={() => onChange([...value, { kind: 'trim' }])}
      >
        {t('imports:columns.addTransform')}
      </Button>
    </Box>
  );
}
