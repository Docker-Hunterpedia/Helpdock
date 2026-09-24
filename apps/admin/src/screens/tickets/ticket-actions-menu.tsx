import { IconButton, ListItemIcon, Menu, MenuItem } from '@mui/material';
import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';

/**
 * The ⋯ menu beside Close in the ticket header (`AdminTicketDialogs`, panel 2).
 *
 * It takes its items as data so that each deliverable adds its own without
 * editing the others': M1-09's merge and split, M1-12's "Log time…", M1-11's
 * "Mark as spam" (last, in danger). With no items the button is drawn disabled,
 * which is what the header showed before any of them existed.
 */

export interface TicketHeaderAction {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly danger?: boolean;
  onSelect(): void;
}

export function TicketActionsMenu({
  actions,
}: {
  readonly actions: readonly TicketHeaderAction[];
}): ReactNode {
  const t = useT();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <IconButton
        size="small"
        aria-label={t('tickets:header.more')}
        aria-haspopup="menu"
        aria-controls={anchor === null ? undefined : menuId}
        aria-expanded={anchor !== null}
        disabled={actions.length === 0}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </IconButton>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
        slotProps={{ list: { 'aria-label': t('tickets:header.actions') } }}
      >
        {actions.map(({ key, label, icon: Icon, danger = false, onSelect }) => (
          <MenuItem
            key={key}
            onClick={() => {
              setAnchor(null);
              onSelect();
            }}
            sx={danger ? { color: 'error.main' } : undefined}
          >
            <ListItemIcon sx={danger ? { color: 'inherit' } : undefined}>
              <Icon size={16} aria-hidden="true" />
            </ListItemIcon>
            {label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
