import type { StatusColor, TicketStatus, TicketSystemState } from '@helpdock/schemas';
import { TICKET_STATUS_NAME_MAX_LENGTH } from '@helpdock/schemas';
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

/**
 * The side column of the Statuses tab: "Edit status · <name>", or the form that
 * makes a new one.
 *
 * It is a real `<form>` so Enter submits and the browser announces it as one,
 * and the delete link is a danger-coloured button below Cancel and Save
 * because it does something the other two cannot undo — the same shape
 * `department-editor.tsx` uses, for the same reasons.
 *
 * **A seeded status shows its flags disabled rather than hiding them.** The
 * person is choosing between statuses, and one whose flags simply vanished
 * would look like one that has none; a disabled checkbox with a note saying why
 * is the honest version (DESIGN §10).
 */

/** The four of DOMAIN-RULES §2.1, in the order the artboard's select lists them. */
const SYSTEM_STATES: readonly TicketSystemState[] = ['open', 'on_hold', 'escalated', 'closed'];

/** The five status hues of DESIGN §2.1. A brand tints; it never adds a hue. */
const COLOURS: readonly StatusColor[] = ['info', 'success', 'warning', 'danger', 'escalated'];

export interface StatusDraft {
  readonly name: string;
  readonly nameAr: string | null;
  readonly systemState: TicketSystemState;
  readonly pausesSla: boolean;
  readonly awaitingCustomer: boolean;
  readonly color: StatusColor;
}

export function StatusEditor({
  status,
  ticketCount,
  fallbackName,
  busy,
  onSubmit,
  onCancel,
  onDelete,
}: {
  /** Null while the card is making a new status rather than editing one. */
  readonly status: TicketStatus | null;
  /** How many tickets the delete link says would move. */
  readonly ticketCount: number;
  /** Where they would move to: the brand's default open status. */
  readonly fallbackName: string;
  readonly busy: boolean;
  onSubmit(draft: StatusDraft): void;
  onCancel(): void;
  /** Absent while creating, and for a seeded or default status. */
  onDelete?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const nameId = useId();
  const nameArId = useId();
  const stateId = useId();
  const colourId = useId();

  const [name, setName] = useState(status?.name ?? '');
  const [nameAr, setNameAr] = useState(status?.nameAr ?? '');
  const [systemState, setSystemState] = useState<TicketSystemState>(status?.systemState ?? 'open');
  const [pausesSla, setPausesSla] = useState(status?.pausesSla ?? false);
  const [awaitingCustomer, setAwaitingCustomer] = useState(status?.awaitingCustomer ?? false);
  const [color, setColor] = useState<StatusColor>(status?.color ?? 'info');

  // Selecting another row re-fills the card rather than re-mounting it, and
  // depends on the id alone for the reason `department-editor.tsx` gives: the
  // whole object changes on every background refetch, and half a typed name
  // would vanish with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different status" is its id; see above.
  useEffect(() => {
    setName(status?.name ?? '');
    setNameAr(status?.nameAr ?? '');
    setSystemState(status?.systemState ?? 'open');
    setPausesSla(status?.pausesSla ?? false);
    setAwaitingCustomer(status?.awaitingCustomer ?? false);
    setColor(status?.color ?? 'info');
  }, [status?.id]);

  const locked = status?.isSystem === true;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '') {
      return;
    }

    onSubmit({
      name: name.trim(),
      nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
      systemState,
      pausesSla,
      awaitingCustomer,
      color,
    });
  };

  const heading =
    status === null
      ? t('ticketing:statuses.editor.newHeading')
      : t('ticketing:statuses.editor.heading', { name: status.name });

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

      <Field id={nameId} label={t('ticketing:statuses.editor.name')}>
        <TextField
          id={nameId}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: TICKET_STATUS_NAME_MAX_LENGTH } }}
        />
      </Field>

      <Field
        id={nameArId}
        label={t('ticketing:statuses.editor.nameAr')}
        hint={t('ticketing:statuses.editor.nameArHint')}
      >
        <TextField
          id={nameArId}
          value={nameAr}
          onChange={(event) => {
            setNameAr(event.target.value);
          }}
          size="small"
          slotProps={{
            htmlInput: { maxLength: TICKET_STATUS_NAME_MAX_LENGTH, dir: 'rtl', lang: 'ar' },
          }}
        />
      </Field>

      <Field
        id={stateId}
        label={t('ticketing:statuses.editor.systemState')}
        hint={t('ticketing:statuses.editor.systemStateHint')}
      >
        <Select
          id={stateId}
          value={systemState}
          onChange={(event) => {
            setSystemState(event.target.value as TicketSystemState);
          }}
          size="small"
          disabled={locked}
          // MUI's `Select` is a `div[role="combobox"]`, which a `<label for>`
          // cannot point at, so the accessible name is set here.
          inputProps={{ 'aria-label': t('ticketing:statuses.editor.systemState') }}
        >
          {SYSTEM_STATES.map((state) => (
            <MenuItem key={state} value={state}>
              {t(`ticketing:statuses.states.${state}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      <FormControlLabel
        control={
          <Checkbox
            checked={pausesSla}
            disabled={locked}
            onChange={(event) => {
              setPausesSla(event.target.checked);
            }}
          />
        }
        label={t('ticketing:statuses.editor.pausesSla')}
      />

      <FormControlLabel
        control={
          <Checkbox
            checked={awaitingCustomer}
            disabled={locked}
            onChange={(event) => {
              setAwaitingCustomer(event.target.checked);
            }}
          />
        }
        label={t('ticketing:statuses.editor.awaitingCustomer')}
      />

      <Field id={colourId} label={t('ticketing:statuses.editor.colour')}>
        <Select
          id={colourId}
          value={color}
          onChange={(event) => {
            setColor(event.target.value as StatusColor);
          }}
          size="small"
          inputProps={{ 'aria-label': t('ticketing:statuses.editor.colour') }}
        >
          {COLOURS.map((hue) => (
            <MenuItem key={hue} value={hue}>
              {t(`ticketing:statuses.colours.${hue}`)}
            </MenuItem>
          ))}
        </Select>
      </Field>

      {locked ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:statuses.editor.systemNote')}
        </Typography>
      ) : null}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || name.trim() === ''}>
          {status === null
            ? t('ticketing:statuses.editor.create')
            : t('ticketing:statuses.editor.save')}
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
          {t('ticketing:statuses.editor.delete', {
            count: ticketCount,
            fallback: fallbackName,
          })}
        </Button>
      )}
    </Box>
  );
}
