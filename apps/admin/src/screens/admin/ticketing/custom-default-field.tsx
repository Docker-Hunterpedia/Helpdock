import type { CustomFieldDef } from '@helpdock/schemas';
import { Checkbox, FormControlLabel, MenuItem, Select, TextField } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { Field } from '../../../ui/field.tsx';

/**
 * One custom field, as a template's default value.
 *
 * A control per type rather than a text box for all six, because the api
 * validates a template's defaults against the definitions when it is saved: a
 * checkbox typed as `"true"` would be refused there, and the person who has to
 * fix it is the one in front of this card.
 *
 * `undefined` means "the template says nothing", which is not the same as a
 * value of `false` or of an empty string, so clearing a control removes the key
 * rather than storing a blank.
 */
export function CustomDefaultField({
  def,
  value,
  disabled,
  onChange,
}: {
  readonly def: CustomFieldDef;
  readonly value: unknown;
  readonly disabled: boolean;
  onChange(next: unknown): void;
}): ReactNode {
  const id = useId();

  if (def.type === 'checkbox') {
    return (
      <FormControlLabel
        control={
          <Checkbox
            checked={value === true}
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.checked ? true : undefined);
            }}
            slotProps={{ input: { 'aria-label': def.label } }}
          />
        }
        label={def.label}
      />
    );
  }

  if (def.type === 'select') {
    return (
      <Field id={id} label={def.label}>
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          size="small"
          displayEmpty
          onChange={(event) => {
            onChange(event.target.value === '' ? undefined : event.target.value);
          }}
          inputProps={{ 'aria-label': def.label }}
        >
          <MenuItem value="">—</MenuItem>
          {def.options.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </Select>
      </Field>
    );
  }

  if (def.type === 'multi_select') {
    const chosen = Array.isArray(value) ? (value as string[]) : [];

    return (
      <Field id={id} label={def.label}>
        <Select
          id={id}
          multiple
          value={chosen}
          disabled={disabled}
          size="small"
          onChange={(event) => {
            const next = event.target.value;
            const values = typeof next === 'string' ? next.split(',') : next;
            onChange(values.length === 0 ? undefined : values);
          }}
          inputProps={{ 'aria-label': def.label }}
        >
          {def.options.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </Select>
      </Field>
    );
  }

  return (
    <Field id={id} label={def.label}>
      <TextField
        id={id}
        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
        disabled={disabled}
        size="small"
        // `number` and `date` are coerced by the api from the string a form
        // field holds, which is what these input types produce.
        type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
        onChange={(event) => {
          onChange(event.target.value === '' ? undefined : event.target.value);
        }}
      />
    </Field>
  );
}
