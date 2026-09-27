import type { SlaAction } from '@helpdock/schemas';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
} from '@mui/material';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../../../app/i18n.js';

/** Who and what an escalation action can name, read once by the SLAs tab. */
export interface PickOptions {
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  readonly people: readonly { readonly id: string; readonly name: string }[];
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly tags: readonly { readonly id: string; readonly name: string }[];
}

/** The actions that name somebody or something, and so ask first. */
export type ActionPick = 'team' | 'notifyUser' | 'reassign' | 'tag';

/**
 * DESIGN §6.4 Dialog, in its confirmation size: one select and Add. It asks
 * for the one thing an action names — the team to notify, the person to
 * notify or reassign to, the tag to add — and hands back the finished action.
 */
export function ActionPickerDialog({
  pick,
  options,
  onClose,
  onPick,
}: {
  readonly pick: ActionPick | null;
  readonly options: PickOptions;
  onClose(): void;
  onPick(action: SlaAction): void;
}): ReactNode {
  const t = useT();
  const list =
    pick === 'team'
      ? options.teams
      : pick === 'tag'
        ? options.tags
        : pick === null
          ? []
          : options.people;
  const [chosen, setChosen] = useState('');

  useEffect(() => {
    setChosen(list[0]?.id ?? '');
  }, [list]);

  const finish = (): void => {
    if (chosen === '' || pick === null) {
      return;
    }
    switch (pick) {
      case 'team':
        onPick({ type: 'notify', recipient: { kind: 'team', teamId: chosen } });
        return;
      case 'notifyUser':
        onPick({ type: 'notify', recipient: { kind: 'user', userId: chosen } });
        return;
      case 'reassign':
        onPick({ type: 'reassign', userId: chosen });
        return;
      case 'tag':
        onPick({ type: 'add_tag', tagId: chosen });
        return;
    }
  };

  return (
    <Dialog open={pick !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{pick === null ? '' : t(`ticketing:slas.picker.${pick}`)}</DialogTitle>
      <DialogContent>
        {list.length === 0 ? (
          t('ticketing:slas.picker.none')
        ) : (
          <TextField
            select
            fullWidth
            size="small"
            margin="dense"
            label={t('ticketing:slas.picker.choose')}
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {list.map((entry) => (
              <MenuItem key={entry.id} value={entry.id}>
                {entry.name}
              </MenuItem>
            ))}
          </TextField>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="text" onClick={onClose}>
          {t('ticketing:slas.picker.cancel')}
        </Button>
        <Button variant="contained" disabled={chosen === ''} onClick={finish}>
          {t('ticketing:slas.picker.add')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
