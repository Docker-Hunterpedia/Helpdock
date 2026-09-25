import type { Department, TicketView, TicketViewVisibility } from '@helpdock/schemas';
import { VIEW_NAME_MAX_LENGTH } from '@helpdock/schemas';
import {
  Box,
  Chip,
  FormControlLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { Field } from '../../ui/field.tsx';

/**
 * The dialogs of `Admin/View-Dialogs` (M1-05): "Save as a view" (panel 3), and
 * the Rename and "Share with…" steps of the sidebar's ⋯ menu (panel 2).
 *
 * All three are {@link ConfirmDialog}s with a field under the sentence, so they
 * are sized, titled and dismissed the way every other short dialog of the desk
 * is. None decides what the reader may do: the sharing choice is drawn for the
 * roles that hold `ticketing:manage`, and the api refuses a department the
 * reader does not lead whatever the dialog offered.
 */

export interface SaveViewValue {
  readonly name: string;
  readonly visibility: TicketViewVisibility;
}

export function SaveViewDialog({
  open,
  summary,
  canShare,
  departments,
  busy,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  /** The filters and sort in words: the "Saves" line. */
  readonly summary: string;
  /** Agents do not see the sharing choice (panel 3's note). */
  readonly canShare: boolean;
  readonly departments: readonly Department[];
  readonly busy: boolean;
  onSubmit(value: SaveViewValue): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const nameId = useId();
  const audienceId = useId();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>([]);

  useEffect(() => {
    if (open) {
      setName('');
      setShared(false);
      setChosen([]);
    }
  }, [open]);

  const sharing = canShare && shared;

  return (
    <ConfirmDialog
      open={open}
      busy={busy}
      title={t('tickets:viewDialog.title')}
      body={t('tickets:viewDialog.body')}
      confirmLabel={t('tickets:viewDialog.submit')}
      confirmDisabled={name.trim() === '' || (sharing && chosen.length === 0)}
      onClose={onClose}
      onConfirm={() => {
        onSubmit({
          name: name.trim(),
          visibility: sharing
            ? { kind: 'departments', departmentIds: [...chosen] }
            : { kind: 'personal' },
        });
      }}
    >
      <Field id={nameId} label={t('tickets:viewDialog.name')}>
        <TextField
          id={nameId}
          size="small"
          value={name}
          autoFocus
          slotProps={{ htmlInput: { maxLength: VIEW_NAME_MAX_LENGTH } }}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>

      {canShare ? (
        <Box component="fieldset" sx={{ border: 0, padding: 0, margin: 0 }}>
          <Typography
            component="legend"
            id={audienceId}
            sx={{ fontSize: 13, fontWeight: 500, paddingBlockEnd: '6px' }}
          >
            {t('tickets:viewDialog.audience')}
          </Typography>
          <RadioGroup
            aria-labelledby={audienceId}
            value={shared ? 'departments' : 'personal'}
            onChange={(event) => {
              setShared(event.target.value === 'departments');
            }}
            sx={{ gap: 2 }}
          >
            <Choice
              value="personal"
              label={t('tickets:viewDialog.onlyMe')}
              hint={t('tickets:viewDialog.onlyMeHint')}
            />
            <Choice
              value="departments"
              label={t('tickets:viewDialog.departments')}
              hint={t('tickets:viewDialog.departmentsHint')}
            />
          </RadioGroup>
          {sharing ? (
            <DepartmentChoice departments={departments} chosen={chosen} onChange={setChosen} />
          ) : null}
        </Box>
      ) : null}

      <Box
        sx={{
          display: 'flex',
          gap: 2,
          paddingBlock: 2,
          paddingInline: 3,
          borderRadius: '8px',
          backgroundColor: tokens['bg.muted'],
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
          {t('tickets:viewDialog.saves')}
        </Typography>
        <Typography variant="caption">{summary}</Typography>
      </Box>
    </ConfirmDialog>
  );
}

function Choice({
  value,
  label,
  hint,
}: {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}): ReactNode {
  return (
    <FormControlLabel
      value={value}
      control={<Radio size="small" sx={{ padding: 0, marginBlockStart: '2px' }} />}
      sx={{ alignItems: 'flex-start', gap: 2, marginInline: 0 }}
      label={
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography component="span" variant="body2" sx={{ fontWeight: 500 }}>
            {label}
          </Typography>
          <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
            {hint}
          </Typography>
        </Box>
      }
    />
  );
}

/** Toggle chips, one per department: the "Departments" choice of panel 3 and of the Views tab. */
export function DepartmentChoice({
  departments,
  chosen,
  onChange,
}: {
  readonly departments: readonly Pick<Department, 'id' | 'name'>[];
  readonly chosen: readonly string[];
  onChange(next: readonly string[]): void;
}): ReactNode {
  const t = useT();

  return (
    <Box
      role="group"
      aria-label={t('tickets:viewDialog.departmentList')}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 2,
        paddingBlockStart: 2,
        paddingInlineStart: 6,
      }}
    >
      {departments.map((department) => {
        const on = chosen.includes(department.id);
        return (
          <Chip
            key={department.id}
            size="small"
            label={department.name}
            color={on ? 'primary' : 'default'}
            variant={on ? 'filled' : 'outlined'}
            aria-pressed={on}
            onClick={() => {
              onChange(
                on ? chosen.filter((id) => id !== department.id) : [...chosen, department.id],
              );
            }}
          />
        );
      })}
    </Box>
  );
}

export function RenameViewDialog({
  view,
  busy,
  onSubmit,
  onClose,
}: {
  /** The view being renamed; null while the dialog is closed. */
  readonly view: TicketView | null;
  readonly busy: boolean;
  onSubmit(name: string): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const nameId = useId();
  const [name, setName] = useState('');

  useEffect(() => {
    if (view !== null) {
      setName(view.name);
    }
  }, [view]);

  return (
    <ConfirmDialog
      open={view !== null}
      busy={busy}
      title={t('tickets:viewDialog.renameTitle', { name: view?.name ?? '' })}
      body={t('tickets:viewDialog.body')}
      confirmLabel={t('tickets:viewDialog.renameSubmit')}
      confirmDisabled={name.trim() === ''}
      onClose={onClose}
      onConfirm={() => {
        onSubmit(name.trim());
      }}
    >
      <Field id={nameId} label={t('tickets:viewDialog.name')}>
        <TextField
          id={nameId}
          size="small"
          value={name}
          autoFocus
          slotProps={{ htmlInput: { maxLength: VIEW_NAME_MAX_LENGTH } }}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}

export function ShareViewDialog({
  view,
  departments,
  busy,
  onSubmit,
  onClose,
}: {
  readonly view: TicketView | null;
  readonly departments: readonly Department[];
  readonly busy: boolean;
  onSubmit(departmentIds: readonly string[]): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const [chosen, setChosen] = useState<readonly string[]>([]);

  useEffect(() => {
    if (view !== null) {
      setChosen([]);
    }
  }, [view]);

  return (
    <ConfirmDialog
      open={view !== null}
      busy={busy}
      title={t('tickets:viewDialog.shareTitle', { name: view?.name ?? '' })}
      body={t('tickets:viewDialog.shareBody')}
      confirmLabel={t('tickets:viewDialog.shareSubmit')}
      confirmDisabled={chosen.length === 0}
      onClose={onClose}
      onConfirm={() => {
        onSubmit(chosen);
      }}
    >
      <DepartmentChoice departments={departments} chosen={chosen} onChange={setChosen} />
    </ConfirmDialog>
  );
}
