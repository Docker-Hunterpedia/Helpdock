import type {
  AssignmentMode,
  DepartmentAssignment,
  DepartmentAssignmentUpdateRequest,
  OnUnassign,
} from '@helpdock/schemas';
import {
  AUTO_UNASSIGN_MINUTES_MAX,
  assignmentModeSchema,
  LOAD_CAP_MAX,
  onUnassignSchema,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';

/**
 * The side column of the Assignment tab (`Admin/Ticketing-Assignment`): how the
 * selected department hands out tickets. The same card every tab of the screen
 * draws, holding the four settings of REQUIREMENTS §4.1 and DOMAIN-RULES §12.
 *
 * The two numbers are typed as text and checked here, because an empty load
 * cap *means* something — no cap — and a number input would read an empty box
 * and a malformed one as the same `NaN`.
 */

/** A whole number within the range, or null for an empty box. `undefined` is "not a number". */
export const parseWhole = (text: string, max: number): number | null | undefined => {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);

  return value >= 1 && value <= max ? value : undefined;
};

export function AssignmentEditor({
  department,
  departmentName,
  busy,
  onSubmit,
}: {
  readonly department: DepartmentAssignment;
  /** In the viewer's language. */
  readonly departmentName: string;
  readonly busy: boolean;
  onSubmit(request: DepartmentAssignmentUpdateRequest): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();
  const modeId = useId();
  const capId = useId();
  const minutesId = useId();
  const onUnassignId = useId();

  const [mode, setMode] = useState<AssignmentMode>(department.mode);
  const [cap, setCap] = useState(department.loadCap === null ? '' : String(department.loadCap));
  const [autoUnassign, setAutoUnassign] = useState(department.autoUnassignOffline);
  const [minutes, setMinutes] = useState(String(department.autoUnassignAfterMinutes));
  const [onUnassign, setOnUnassign] = useState<OnUnassign>(department.onUnassign);

  const reset = (): void => {
    setMode(department.mode);
    setCap(department.loadCap === null ? '' : String(department.loadCap));
    setAutoUnassign(department.autoUnassignOffline);
    setMinutes(String(department.autoUnassignAfterMinutes));
    setOnUnassign(department.onUnassign);
  };

  // Follows the selection only, for the reason `TagEditor` gives: a background
  // refetch must not wipe half a typed number.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different department" is its id.
  useEffect(reset, [department.departmentId]);

  const loadCap = parseWhole(cap, LOAD_CAP_MAX);
  const afterMinutes = parseWhole(minutes, AUTO_UNASSIGN_MINUTES_MAX);
  const capError =
    loadCap === undefined ? t('ticketing:assignment.editor.loadCapInvalid') : undefined;
  // The minutes only matter while the timer is on; a box left half-typed under a
  // switched-off timer keeps the stored value rather than blocking the save.
  const minutesError =
    autoUnassign && (afterMinutes === undefined || afterMinutes === null)
      ? t('ticketing:assignment.editor.minutesInvalid')
      : undefined;
  const invalid = capError !== undefined || minutesError !== undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (loadCap === undefined || invalid) {
      return;
    }

    onSubmit({
      mode,
      loadCap,
      autoUnassignOffline: autoUnassign,
      autoUnassignAfterMinutes: afterMinutes ?? department.autoUnassignAfterMinutes,
      onUnassign,
    });
  };

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-labelledby={headingId}
      noValidate
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography id={headingId} variant="h3" component="h2">
        {t('ticketing:assignment.editor.heading', { department: departmentName })}
      </Typography>

      <Box component="fieldset" sx={{ border: 0, padding: 0, margin: 0 }}>
        <Typography
          id={modeId}
          component="legend"
          sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px', paddingBlockEnd: '6px' }}
        >
          {t('ticketing:assignment.editor.mode')}
        </Typography>
        <RadioGroup
          aria-labelledby={modeId}
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as AssignmentMode);
          }}
          sx={{ gap: 2 }}
        >
          {assignmentModeSchema.options.map((option) => (
            <FormControlLabel
              key={option}
              value={option}
              disabled={busy}
              control={<Radio size="small" sx={{ paddingBlock: 0 }} />}
              sx={{ alignItems: 'flex-start', marginInline: 0, gap: 2 }}
              label={
                <Box component="span" sx={{ display: 'flex', flexDirection: 'column' }}>
                  <span>{t(`ticketing:assignment.modes.${option}`)}</span>
                  <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
                    {t(`ticketing:assignment.modeHints.${option}`)}
                  </Typography>
                </Box>
              }
            />
          ))}
        </RadioGroup>
      </Box>

      <Field
        id={capId}
        label={t('ticketing:assignment.editor.loadCap')}
        hint={t('ticketing:assignment.editor.loadCapHint')}
        error={capError}
      >
        <TextField
          id={capId}
          value={cap}
          onChange={(event) => {
            setCap(event.target.value);
          }}
          size="small"
          error={capError !== undefined}
          sx={{ inlineSize: 96 }}
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              'aria-describedby': fieldDescribedBy(capId, {
                hint: t('ticketing:assignment.editor.loadCapHint'),
                error: capError,
              }),
              'aria-invalid': capError !== undefined,
            },
          }}
        />
      </Field>

      <Box>
        <FormControlLabel
          control={
            <Checkbox
              checked={autoUnassign}
              disabled={busy}
              onChange={(event) => {
                setAutoUnassign(event.target.checked);
              }}
            />
          }
          label={t('ticketing:assignment.editor.autoUnassign')}
          sx={{ marginInline: 0 }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, paddingInlineStart: 6 }}>
          <TextField
            id={minutesId}
            value={minutes}
            onChange={(event) => {
              setMinutes(event.target.value);
            }}
            size="small"
            disabled={!autoUnassign || busy}
            error={minutesError !== undefined}
            sx={{ inlineSize: 72 }}
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                'aria-label': t('ticketing:assignment.editor.minutes'),
                'aria-invalid': minutesError !== undefined,
                ...(minutesError === undefined ? {} : { 'aria-describedby': `${minutesId}-error` }),
              },
            }}
          />
          <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
            {t('ticketing:assignment.editor.minutesSuffix')}
          </Typography>
        </Box>
        {minutesError === undefined ? null : (
          <Typography
            id={`${minutesId}-error`}
            variant="caption"
            component="p"
            sx={{ marginBlockStart: '6px', color: tokens['status.danger.text'] }}
          >
            {minutesError}
          </Typography>
        )}
      </Box>

      <Field
        id={onUnassignId}
        label={t('ticketing:assignment.editor.onUnassign')}
        hint={t('ticketing:assignment.editor.onUnassignHint')}
      >
        <Select
          id={onUnassignId}
          value={onUnassign}
          size="small"
          disabled={busy}
          onChange={(event) => {
            setOnUnassign(event.target.value as OnUnassign);
          }}
          // MUI's `Select` is a `div[role="combobox"]`, which a `<label for>`
          // cannot name, so the name is set here in the same words.
          inputProps={{ 'aria-label': t('ticketing:assignment.editor.onUnassign') }}
        >
          {onUnassignSchema.options.map((option) => (
            <MenuItem key={option} value={option}>
              {t(`ticketing:assignment.editor.onUnassignOptions.${option}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button variant="text" onClick={reset} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || invalid}>
          {t('ticketing:assignment.editor.save')}
        </Button>
      </Box>
    </Box>
  );
}
