import type { CustomFieldDef, TicketFieldFilter } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { fieldLabel } from '../../tickets/custom-values.js';
import {
  blankDraft,
  draftOfFilter,
  type FieldFilterDraft,
  type FieldFilterOp,
  filtersOfDrafts,
  operatorsOf,
} from '../../tickets/field-filter-draft.js';

/**
 * The custom-field rows of the Filter popover and of the view editor
 * (`Admin/Ticketing-FieldFilters`, M14-16): a field, an operator that suits its
 * type, and the value the operator needs. "Add filter" lists the fields not yet
 * filtered, because the api takes one filter per field.
 *
 * The rows are a draft. A row with an operator and no value is not a filter,
 * so only complete rows reach `onChange`. With `applyLabel` the popover waits
 * for Apply, as the artboard draws it, because a text filter would otherwise
 * re-read the list on every keystroke; without it (the view editor) each change
 * is passed on as it is made.
 *
 * `fields` is what the reader may see (`ticketFieldsFor`): a field hidden from
 * Agents is not offered to them, and the api refuses it if asked.
 */

const OP_KEYS = {
  any_of: 'tickets:fieldFilters.ops.any_of',
  not_set: 'tickets:fieldFilters.ops.not_set',
  is: 'tickets:fieldFilters.ops.is',
  before: 'tickets:fieldFilters.ops.before',
  after: 'tickets:fieldFilters.ops.after',
  between: 'tickets:fieldFilters.ops.between',
  contains: 'tickets:fieldFilters.ops.contains',
} as const satisfies Record<FieldFilterOp, string>;

const json = (filters: readonly TicketFieldFilter[]): string => JSON.stringify(filters);

export function FieldFilterEditor({
  fields,
  value,
  disabled = false,
  applyLabel,
  onChange,
}: {
  readonly fields: readonly CustomFieldDef[];
  readonly value: readonly TicketFieldFilter[];
  readonly disabled?: boolean;
  /** Present in the popover: the rows are sent when it is pressed, not as they change. */
  readonly applyLabel?: string;
  onChange(filters: readonly TicketFieldFilter[]): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const menuId = useId();
  const [rows, setRows] = useState<readonly FieldFilterDraft[]>(() => value.map(draftOfFilter));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const defOf = (key: string): CustomFieldDef | undefined =>
    fields.find((field) => field.key === key);

  const complete = filtersOfDrafts(rows, fields);
  // A row whose field is gone (deleted, or hidden from this reader) is dropped
  // on Apply rather than blocking it.
  const incomplete = rows.filter((row) => defOf(row.key) !== undefined).length - complete.length;

  // The rows follow the filters when something else changes them (a chip
  // removed, a view opened) but not when they are only the echo of the rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is compared by content.
  useEffect(() => {
    if (json(filtersOfDrafts(rows, fields)) !== json(value)) {
      setRows(value.map(draftOfFilter));
    }
  }, [json(value)]);

  const update = (next: readonly FieldFilterDraft[]): void => {
    setRows(next);
    if (applyLabel === undefined) {
      onChange(filtersOfDrafts(next, fields));
    }
  };
  const patch = (key: string, change: Partial<FieldFilterDraft>): void => {
    update(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };

  const unused = fields.filter((field) => !rows.some((row) => row.key === field.key));
  const changed = json(complete) !== json(value);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.length === 0 ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('tickets:fieldFilters.none')}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{ display: 'flex', flexDirection: 'column', gap: 2, margin: 0, padding: 0 }}
        >
          {rows.map((row) => {
            const def = defOf(row.key);
            if (def === undefined) {
              return null;
            }
            const label = fieldLabel(def, locale);

            return (
              <Box
                component="li"
                key={row.key}
                sx={{
                  listStyle: 'none',
                  display: 'grid',
                  gridTemplateColumns: '112px 128px minmax(0, 1fr) 28px',
                  gap: 2,
                  alignItems: 'center',
                }}
              >
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {label}
                </Typography>
                <TextField
                  select
                  size="small"
                  value={row.op}
                  disabled={disabled}
                  slotProps={{
                    select: { native: true },
                    htmlInput: {
                      'aria-label': t('tickets:fieldFilters.operatorOf', { field: label }),
                    },
                  }}
                  onChange={(event) => {
                    patch(row.key, { op: event.target.value as FieldFilterOp });
                  }}
                >
                  {operatorsOf(def.type).map((op) => (
                    <option key={op} value={op}>
                      {t(OP_KEYS[op])}
                    </option>
                  ))}
                </TextField>
                <ValueControl
                  row={row}
                  def={def}
                  label={label}
                  disabled={disabled}
                  onPatch={(change) => patch(row.key, change)}
                />
                <IconButton
                  size="small"
                  disabled={disabled}
                  aria-label={t('tickets:fieldFilters.remove', { field: label })}
                  onClick={() => {
                    update(rows.filter((other) => other.key !== row.key));
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </IconButton>
              </Box>
            );
          })}
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Button
          variant="text"
          size="small"
          disabled={disabled || unused.length === 0}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor === null ? undefined : menuId}
          startIcon={<Plus size={16} aria-hidden="true" />}
          onClick={(event) => {
            setAnchor(event.currentTarget);
          }}
        >
          {t('tickets:fieldFilters.add')}
        </Button>
        {applyLabel === undefined ? null : (
          <Button
            variant="contained"
            size="small"
            disabled={incomplete > 0 || !changed}
            onClick={() => {
              onChange(complete);
            }}
          >
            {applyLabel}
          </Button>
        )}
      </Box>
      {incomplete > 0 && applyLabel !== undefined ? (
        <Typography variant="caption" role="status" sx={{ color: 'text.secondary' }}>
          {t('tickets:fieldFilters.incomplete', { count: incomplete })}
        </Typography>
      ) : null}

      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
      >
        {unused.map((field) => (
          <MenuItem
            key={field.key}
            onClick={() => {
              setAnchor(null);
              update([...rows, blankDraft(field)]);
            }}
          >
            {fieldLabel(field, locale)}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

/** The part of a row that depends on its operator: option chips, a box, two boxes, or nothing. */
function ValueControl({
  row,
  def,
  label,
  disabled,
  onPatch,
}: {
  readonly row: FieldFilterDraft;
  readonly def: CustomFieldDef;
  readonly label: string;
  readonly disabled: boolean;
  onPatch(change: Partial<FieldFilterDraft>): void;
}): ReactNode {
  const t = useT();
  const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
  const box = (name: string, text: string, onText: (text: string) => void): ReactNode => (
    <TextField
      size="small"
      type={type}
      value={text}
      disabled={disabled}
      // Numbers, days and addresses are Latin runs even in an Arabic sentence.
      dir={type === 'text' ? 'auto' : 'ltr'}
      slotProps={{ htmlInput: { 'aria-label': name } }}
      onChange={(event) => {
        onText(event.target.value);
      }}
    />
  );

  switch (row.op) {
    case 'not_set':
      return <span />;
    case 'any_of':
      return (
        <Box
          role="group"
          aria-label={t('tickets:fieldFilters.valueOf', { field: label })}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
        >
          {def.options.map((option) => {
            const on = row.values.includes(option);
            return (
              <Chip
                key={option}
                size="small"
                label={option}
                variant={on ? 'filled' : 'outlined'}
                disabled={disabled}
                role="switch"
                aria-checked={on}
                onClick={() => {
                  onPatch({
                    values: on
                      ? row.values.filter((other) => other !== option)
                      : [...row.values, option],
                  });
                }}
              />
            );
          })}
        </Box>
      );
    case 'is':
      return (
        <TextField
          select
          size="small"
          value={row.flag ? 'yes' : 'no'}
          disabled={disabled}
          slotProps={{
            select: { native: true },
            htmlInput: { 'aria-label': t('tickets:fieldFilters.valueOf', { field: label }) },
          }}
          onChange={(event) => {
            onPatch({ flag: event.target.value === 'yes' });
          }}
        >
          <option value="yes">{t('tickets:fieldFilters.ticked')}</option>
          <option value="no">{t('tickets:fieldFilters.unticked')}</option>
        </TextField>
      );
    case 'between':
      return (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 2 }}>
          {box(t('tickets:fieldFilters.from', { field: label }), row.text, (text) =>
            onPatch({ text }),
          )}
          {box(t('tickets:fieldFilters.to', { field: label }), row.to, (to) => onPatch({ to }))}
        </Box>
      );
    default:
      return box(t('tickets:fieldFilters.valueOf', { field: label }), row.text, (text) =>
        onPatch({ text }),
      );
  }
}
