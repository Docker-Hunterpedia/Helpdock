import type { CustomFieldDef } from '@helpdock/schemas';
import { Autocomplete, Box, Checkbox, Chip, MenuItem, TextField, Typography } from '@mui/material';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import {
  type CustomDraft,
  draftChanges,
  draftOf,
  valueOfDraft,
} from '../../tickets/custom-values.js';
import {
  EmailValue,
  LinkInput,
  LinkValue,
  LongTextValue,
  PersonSelect,
  PersonValue,
} from './custom-field-values.tsx';

/**
 * The details panel's custom fields, editable (`AdminTicketTags`, panel 3;
 * M1-15): one editor per definition, of the definition's type, each saving on
 * its own through the ticket `PATCH` with `custom: { [key]: value }`.
 *
 * Text, number and date save on blur (and on Enter, which blurs); select,
 * multi-select and checkbox save on change, because a choice is finished the
 * moment it is made. The api is the only judge of a value
 * (`@helpdock/schemas/custom-fields`): when it refuses, the sentence for the
 * field's type goes under the field as an alert and the editor goes back to
 * what is stored, so what the panel shows is always what the ticket holds.
 */
export function CustomFieldsCard({
  fields,
  values,
  canWrite,
  onSave,
}: {
  /** The ticket's definitions this reader may see, in the brand's order. */
  readonly fields: readonly CustomFieldDef[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly canWrite: boolean;
  /** Resolves once saved; rejects with the api's refusal. */
  onSave(key: string, value: unknown): Promise<void>;
}): ReactNode {
  const t = useT();
  const headingId = useId();

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
        {t('tickets:details.custom')}
      </Typography>
      {fields.length === 0 ? (
        <Typography variant="body2" sx={{ marginBlockStart: 2, color: 'text.secondary' }}>
          {t('tickets:details.noCustom')}
        </Typography>
      ) : (
        <Box sx={{ marginBlockStart: 2, display: 'grid', gap: 2 }}>
          {fields.map((field) => (
            <CustomFieldEditor
              key={field.id}
              def={field}
              stored={values[field.key]}
              disabled={!canWrite}
              onSave={onSave}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Label column, then the editor, then the refusal under the editor: the artboard's grid. */
function CustomFieldEditor({
  def,
  stored,
  disabled,
  onSave,
}: {
  readonly def: CustomFieldDef;
  readonly stored: unknown;
  readonly disabled: boolean;
  onSave(key: string, value: unknown): Promise<void>;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const id = useId();
  const errorId = `${id}-error`;
  const markerId = `${id}-marker`;
  const [draft, setDraft] = useState<CustomDraft>(() => draftOf(def, stored));
  const [refused, setRefused] = useState(false);

  // A save, a colleague's edit or a refetch moved the stored value: draw that.
  const storedJson = JSON.stringify(stored ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `storedJson` is `stored` by value, so an equal read does not reset a draft being typed.
  useEffect(() => {
    setDraft(draftOf(def, stored));
  }, [storedJson, def]);

  const save = async (next: CustomDraft): Promise<void> => {
    if (!draftChanges(def, stored, next)) {
      return;
    }
    setRefused(false);
    try {
      await onSave(def.key, valueOfDraft(def, next));
    } catch {
      setDraft(draftOf(def, stored));
      setRefused(true);
    }
  };

  const label = locale === 'ar' && def.labelAr !== null ? def.labelAr : def.label;
  // A reader who cannot write sees the M14-27 types as they read, not as disabled inputs.
  const display = disabled ? displayFor(def, label, stored, t('tickets:details.customNone')) : null;
  // The marker and a refusal both describe the control, so a reader hears the former first.
  const described =
    [def.requiredToClose ? markerId : undefined, refused ? errorId : undefined]
      .filter((part) => part !== undefined)
      .join(' ') || undefined;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '96px minmax(0, 1fr)',
        columnGap: 2,
        rowGap: 1,
        alignItems: 'center',
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component={display === null ? 'label' : 'span'}
          htmlFor={display === null ? id : undefined}
          variant="caption"
          sx={{ display: 'block', color: 'text.secondary', overflowWrap: 'anywhere' }}
        >
          {label}
        </Typography>
        {def.requiredToClose ? (
          <Typography
            id={markerId}
            variant="caption"
            sx={{ display: 'block', color: 'text.secondary' }}
          >
            {t('tickets:details.requiredToClose')}
          </Typography>
        ) : null}
      </Box>

      {display ??
        editorFor({
          def,
          id,
          label,
          draft,
          disabled,
          refused,
          described,
          none: t('tickets:details.customNone'),
          onDraft: setDraft,
          onCommit: (next) => {
            void save(next);
          },
        })}

      {refused ? (
        <Typography
          id={errorId}
          role="alert"
          variant="caption"
          sx={{ gridColumn: 2, color: tokens['status.danger.text'] }}
        >
          {t(`tickets:details.customRefused.${def.type}`)}
        </Typography>
      ) : null}
    </Box>
  );
}

/** The read-only rendering of the types that read differently from a form control; `null` for the rest. */
function displayFor(
  def: CustomFieldDef,
  label: string,
  stored: unknown,
  none: string,
): ReactNode | null {
  if (!['long_text', 'link', 'email', 'person'].includes(def.type)) {
    return null;
  }
  if (typeof stored !== 'string' || stored === '') {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {none}
      </Typography>
    );
  }

  switch (def.type) {
    case 'long_text':
      return <LongTextValue value={stored} />;
    case 'link':
      return <LinkValue value={stored} label={label} />;
    case 'email':
      return <EmailValue value={stored} />;
    default:
      return <PersonValue userId={stored} />;
  }
}

export interface EditorProps {
  readonly def: CustomFieldDef;
  readonly id: string;
  readonly label: string;
  readonly draft: CustomDraft;
  readonly disabled: boolean;
  readonly refused: boolean;
  readonly described: string | undefined;
  /** The "nothing chosen" option of a select. */
  readonly none: string;
  onDraft(next: CustomDraft): void;
  /** Save this state: on blur for what is typed, on change for what is chosen. */
  onCommit(next: CustomDraft): void;
}

/** One control per type (M1-06's six). The bulk bar's Field dialog (M14-04) draws the same ones. */
export function editorFor(props: EditorProps): ReactNode {
  const { def, id, label, draft, disabled, refused, described, none, onDraft, onCommit } = props;
  const aria = { 'aria-invalid': refused, 'aria-describedby': described };

  switch (def.type) {
    case 'checkbox':
      return (
        <Checkbox
          id={id}
          checked={draft === true}
          disabled={disabled}
          onChange={(event) => {
            onDraft(event.target.checked);
            onCommit(event.target.checked);
          }}
          slotProps={{ input: aria }}
          sx={{ justifySelf: 'start', padding: 0 }}
        />
      );

    case 'select':
      return (
        <TextField
          id={id}
          select
          size="small"
          disabled={disabled}
          value={typeof draft === 'string' ? draft : ''}
          onChange={(event) => {
            onDraft(event.target.value);
            onCommit(event.target.value);
          }}
          slotProps={{
            select: {
              displayEmpty: true,
              SelectDisplayProps: { 'aria-label': label, ...aria },
            },
          }}
        >
          <MenuItem value="">{none}</MenuItem>
          {def.options.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </TextField>
      );

    case 'multi_select':
      return (
        <Autocomplete
          id={id}
          multiple
          size="small"
          disabled={disabled}
          options={def.options}
          value={Array.isArray(draft) ? [...draft] : []}
          onChange={(_event, next) => {
            onDraft(next);
            onCommit(next);
          }}
          renderValue={(value, getItemProps) =>
            value.map((option, index) => {
              const { key, ...chipProps } = getItemProps({ index });

              return <Chip key={key} size="small" label={option} {...chipProps} />;
            })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              slotProps={{
                ...params.slotProps,
                htmlInput: { ...params.slotProps.htmlInput, ...aria },
              }}
            />
          )}
        />
      );

    case 'person':
      return (
        <PersonSelect
          id={id}
          value={typeof draft === 'string' ? draft : ''}
          disabled={disabled}
          describedBy={described}
          invalid={refused}
          label={label}
          onChange={(next) => {
            onDraft(next);
            onCommit(next);
          }}
        />
      );

    case 'long_text':
      return (
        <TextField
          id={id}
          size="small"
          multiline
          minRows={3}
          maxRows={8}
          disabled={disabled}
          value={typeof draft === 'string' ? draft : ''}
          error={refused}
          onChange={(event) => {
            onDraft(event.target.value);
          }}
          onBlur={(event) => {
            onCommit(event.target.value);
          }}
          slotProps={{ htmlInput: aria }}
        />
      );

    case 'link':
      return (
        <LinkInput
          id={id}
          label={label}
          value={typeof draft === 'string' ? draft : ''}
          disabled={disabled}
          invalid={refused}
          describedBy={described}
          onDraft={onDraft}
          onCommit={onCommit}
        />
      );

    default:
      return (
        <TextField
          id={id}
          size="small"
          disabled={disabled}
          type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
          value={typeof draft === 'string' ? draft : ''}
          error={refused}
          onChange={(event) => {
            onDraft(event.target.value);
          }}
          onBlur={(event) => {
            onCommit(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              (event.target as HTMLInputElement).blur();
            }
          }}
          slotProps={{
            htmlInput: def.type === 'email' ? { ...aria, dir: 'ltr' } : aria,
          }}
        />
      );
  }
}
