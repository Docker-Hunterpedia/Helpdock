import type { DepartmentSummary, Team } from '@helpdock/schemas';
import { DEPARTMENT_NAME_MAX_LENGTH } from '@helpdock/schemas';
import { Box, Button, MenuItem, Select, TextField, Typography } from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Field } from '../../../ui/field.tsx';

/**
 * The side column of `Admin/Ticketing`: the editor card for whichever
 * department the list has selected, or the form that makes a new one.
 *
 * It is a real `<form>` so Enter submits and the browser announces it as one.
 * The delete link is a danger-coloured button at the end of the card, apart
 * from Cancel and Save, because it does something the other two cannot undo.
 */

export interface DepartmentDraft {
  readonly name: string;
  readonly nameAr: string | null;
  readonly defaultTeamId: string | null;
}

export function DepartmentEditor({
  department,
  teams,
  busy,
  onSubmit,
  onCancel,
  onDelete,
}: {
  /** Null while the card is making a new department rather than editing one. */
  readonly department: DepartmentSummary | null;
  /** The selected department's own teams; the only ones it may default to. */
  readonly teams: readonly Team[];
  readonly busy: boolean;
  onSubmit(draft: DepartmentDraft): void;
  onCancel(): void;
  /** Absent while creating: there is nothing to delete yet. */
  onDelete?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const nameId = useId();
  const nameArId = useId();
  const defaultTeamId = useId();

  const [name, setName] = useState(department?.name ?? '');
  const [nameAr, setNameAr] = useState(department?.nameAr ?? '');
  const [defaultTeam, setDefaultTeam] = useState(department?.defaultTeamId ?? '');

  // Selecting another row re-fills the card rather than re-mounting it, so the
  // fields follow the selection — and only the selection. Depending on the
  // whole object would re-fill them on every background refetch, which is one
  // per mutation: adding a team changes the selected row's counts, and half a
  // typed name would vanish.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the identity that means "a different department" is its id; see above.
  useEffect(() => {
    setName(department?.name ?? '');
    setNameAr(department?.nameAr ?? '');
    setDefaultTeam(department?.defaultTeamId ?? '');
  }, [department?.id]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (name.trim() === '') {
      return;
    }

    onSubmit({
      name: name.trim(),
      nameAr: nameAr.trim() === '' ? null : nameAr.trim(),
      defaultTeamId: defaultTeam === '' ? null : defaultTeam,
    });
  };

  return (
    <Box
      component="form"
      onSubmit={submit}
      aria-label={
        department === null
          ? t('ticketing:departments.editor.newHeading')
          : t('ticketing:departments.editor.heading')
      }
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
        {department === null
          ? t('ticketing:departments.editor.newHeading')
          : t('ticketing:departments.editor.heading')}
      </Typography>

      <Field id={nameId} label={t('ticketing:departments.editor.name')}>
        <TextField
          id={nameId}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          size="small"
          required
          slotProps={{ htmlInput: { maxLength: DEPARTMENT_NAME_MAX_LENGTH } }}
        />
      </Field>

      <Field
        id={nameArId}
        label={t('ticketing:departments.editor.nameAr')}
        hint={t('ticketing:departments.editor.nameArHint')}
      >
        <TextField
          id={nameArId}
          value={nameAr}
          onChange={(event) => {
            setNameAr(event.target.value);
          }}
          size="small"
          slotProps={{
            htmlInput: { maxLength: DEPARTMENT_NAME_MAX_LENGTH, dir: 'rtl', lang: 'ar' },
          }}
        />
      </Field>

      {department === null ? null : (
        <Field
          id={defaultTeamId}
          label={t('ticketing:departments.editor.defaultTeam')}
          hint={t('ticketing:departments.editor.defaultTeamHint')}
        >
          <Select
            id={defaultTeamId}
            value={teams.some((team) => team.id === defaultTeam) ? defaultTeam : ''}
            onChange={(event) => {
              setDefaultTeam(event.target.value);
            }}
            size="small"
            displayEmpty
            // MUI's own `Select` is a `div[role="combobox"]`, which a `<label
            // for>` cannot point at, so the accessible name is set here. It is
            // the same words the visible label carries.
            inputProps={{ 'aria-label': t('ticketing:departments.editor.defaultTeam') }}
          >
            <MenuItem value="">{t('ticketing:departments.editor.none')}</MenuItem>
            {teams.map((team) => (
              <MenuItem key={team.id} value={team.id}>
                {team.name}
              </MenuItem>
            ))}
          </Select>
        </Field>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button variant="text" onClick={onCancel} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" variant="contained" disabled={busy || name.trim() === ''}>
          {department === null
            ? t('ticketing:departments.editor.create')
            : t('ticketing:departments.editor.save')}
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
          {t('ticketing:departments.editor.delete')}
        </Button>
      )}
    </Box>
  );
}
