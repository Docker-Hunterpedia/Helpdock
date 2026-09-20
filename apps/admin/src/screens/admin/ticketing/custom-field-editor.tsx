import type { CustomFieldDef, CustomFieldTarget, CustomFieldType } from '@helpdock/schemas';
import {
  CUSTOM_FIELD_KEY_MAX,
  CUSTOM_FIELD_LABEL_MAX,
  customFieldTargetSchema,
  customFieldTypeSchema,
  isChoiceField,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field } from '../../../ui/field.tsx';
import { OptionListEditor } from './option-list-editor.tsx';

/**
 * The editor card of the Custom fields tab.
 *
 * Two fields are locked once the definition exists, and the card says so rather
 * than letting somebody try. **The key** is written into every stored value and
 * cannot move; **the type** cannot move while rows carry a value, which only
 * the api knows, so the control stays enabled and the refusal comes back as a
 * toast naming the reason.
 *
 * The key is suggested from the label while a field is being created and stops
 * following it the moment somebody types a key of their own — a suggestion that
 * keeps overwriting what was typed is worse than none.
 */

export interface CustomFieldDraft {
  readonly target: CustomFieldTarget;
  readonly key: string;
  readonly label: string;
  readonly labelAr: string | null;
  readonly type: CustomFieldType;
  readonly options: readonly string[];
  readonly required: boolean;
  readonly agentVisible: boolean;
}

/** `Plan tier` → `plan_tier`: the spelling `customFieldKeySchema` accepts. */
export const keyFromLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f$1')
    .slice(0, CUSTOM_FIELD_KEY_MAX);

export function CustomFieldEditor({
  field,
  target,
  busy,
  onSubmit,
  onCancel,
  onDelete,
}: {
  /** Null while the card is making a new field rather than editing one. */
  readonly field: CustomFieldDef | null;
  /** Which list the new field joins. Ignored while editing: a field never moves. */
  readonly target: CustomFieldTarget;
  readonly busy: boolean;
  onSubmit(draft: CustomFieldDraft): void;
  onCancel(): void;
  onDelete?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const labelId = useId();
  const labelArId = useId();
  const keyId = useId();
  const typeId = useId();
  const placementId = useId();

  const [label, setLabel] = useState(field?.label ?? '');
  const [labelAr, setLabelAr] = useState(field?.labelAr ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(field !== null);
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text');
  const [options, setOptions] = useState<readonly string[]>(field?.options ?? []);
  const [required, setRequired] = useState(field?.required ?? false);
  const [agentVisible, setAgentVisible] = useState(field?.agentVisible ?? true);
  const [placement, setPlacement] = useState<CustomFieldTarget>(field?.target ?? target);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different field" is its id.
  useEffect(() => {
    setLabel(field?.label ?? '');
    setLabelAr(field?.labelAr ?? '');
    setKey(field?.key ?? '');
    setKeyTouched(field !== null);
    setType(field?.type ?? 'text');
    setOptions(field?.options ?? []);
    setRequired(field?.required ?? false);
    setAgentVisible(field?.agentVisible ?? true);
    setPlacement(field?.target ?? target);
  }, [field?.id, target]);

  const choice = isChoiceField(type);
  const effectiveKey = keyTouched ? key : keyFromLabel(label);
  const complete =
    label.trim() !== '' && effectiveKey !== '' && (!choice || options.some((o) => o.trim() !== ''));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!complete) {
      return;
    }

    onSubmit({
      target: placement,
      key: effectiveKey,
      label: label.trim(),
      labelAr: labelAr.trim() === '' ? null : labelAr.trim(),
      type,
      options: choice ? options.map((option) => option.trim()).filter(Boolean) : [],
      required,
      agentVisible,
    });
  };

  const heading =
    field === null
      ? t('ticketing:customFields.editor.newHeading')
      : t('ticketing:customFields.editor.heading');

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={heading}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2">
        {heading}
      </Typography>

      <Field id={labelId} label={t('ticketing:customFields.editor.label')}>
        <TextField
          id={labelId}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: CUSTOM_FIELD_LABEL_MAX } }}
        />
      </Field>

      <Field
        id={labelArId}
        label={t('ticketing:customFields.editor.labelAr')}
        hint={t('ticketing:customFields.editor.labelArHint')}
      >
        <TextField
          id={labelArId}
          value={labelAr}
          onChange={(event) => {
            setLabelAr(event.target.value);
          }}
          size="small"
          slotProps={{ htmlInput: { maxLength: CUSTOM_FIELD_LABEL_MAX, dir: 'rtl', lang: 'ar' } }}
        />
      </Field>

      <Field
        id={keyId}
        label={t('ticketing:customFields.editor.key')}
        hint={
          field === null
            ? t('ticketing:customFields.editor.keyHint')
            : t('ticketing:customFields.editor.keyLocked')
        }
      >
        <TextField
          id={keyId}
          value={effectiveKey}
          disabled={field !== null}
          onChange={(event) => {
            setKeyTouched(true);
            setKey(event.target.value);
          }}
          size="small"
          slotProps={{
            htmlInput: {
              maxLength: CUSTOM_FIELD_KEY_MAX,
              // A key is code, not prose, and it is printed in exports and rule
              // conditions; mono is what DESIGN §3 gives that.
              style: { fontFamily: 'var(--hd-font-mono, monospace)' },
            },
          }}
        />
      </Field>

      <Field id={typeId} label={t('ticketing:customFields.editor.type')}>
        <Select
          id={typeId}
          value={type}
          onChange={(event) => {
            setType(event.target.value as CustomFieldType);
          }}
          size="small"
          inputProps={{ 'aria-label': t('ticketing:customFields.editor.type') }}
        >
          {customFieldTypeSchema.options.map((candidate) => (
            <MenuItem key={candidate} value={candidate}>
              {t(`ticketing:customFields.types.${candidate}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      {choice ? <OptionListEditor options={options} disabled={busy} onChange={setOptions} /> : null}

      <FormControlLabel
        control={
          <Checkbox
            checked={required}
            onChange={(event) => {
              setRequired(event.target.checked);
            }}
          />
        }
        label={t('ticketing:customFields.editor.required')}
      />

      <Field id={placementId} label={t('ticketing:customFields.editor.placement')}>
        <Select
          id={placementId}
          value={placement}
          disabled={field !== null}
          onChange={(event) => {
            setPlacement(event.target.value as CustomFieldTarget);
          }}
          size="small"
          inputProps={{ 'aria-label': t('ticketing:customFields.editor.placement') }}
        >
          {customFieldTargetSchema.options.map((candidate) => (
            <MenuItem key={candidate} value={candidate}>
              {t(`ticketing:customFields.targets.${candidate}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <FormControlLabel
        control={
          <Checkbox
            checked={agentVisible}
            onChange={(event) => {
              setAgentVisible(event.target.checked);
            }}
          />
        }
        label={t('ticketing:customFields.editor.agentVisible')}
      />
      <Typography variant="caption" sx={{ color: 'text.secondary', marginBlockStart: -4 }}>
        {t('ticketing:customFields.editor.agentVisibleHint')}
      </Typography>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || !complete}>
          {field === null
            ? t('ticketing:customFields.editor.create')
            : t('ticketing:customFields.editor.save')}
        </Button>
      </Box>

      {onDelete === undefined ? null : (
        <Button
          variant="text"
          color="error"
          onClick={onDelete}
          disabled={busy}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('ticketing:customFields.editor.delete')}
        </Button>
      )}
    </Box>
  );
}
