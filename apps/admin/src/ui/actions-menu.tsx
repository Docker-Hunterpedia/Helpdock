import { dir } from '@helpdock/i18n';
import { Divider, IconButton, ListItemIcon, Menu, MenuItem } from '@mui/material';
import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { usePreferences } from '../app/providers.tsx';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * A ⋯ button and the menu it opens (DESIGN §6.4 Menu): the ticket header's
 * (panel 2 of `AdminTicketDialogs`) and the contact header's (`Admin/Contact`).
 *
 * It draws whatever `items` it is given, in order, so the deliverables that add
 * to it each add an entry rather than edit this file. The artboard fixes the
 * order; the caller owns it.
 *
 * An empty list draws the button disabled rather than a menu with nothing in
 * it, which is what a Viewer — who may edit nothing — sees.
 */

export interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Danger text, for an item that throws work away (DESIGN §6.4 Menu). */
  readonly tone?: 'danger';
  /** A 1 px divider above this item, which is how the artboard sets spam apart. */
  readonly dividerBefore?: boolean;
  onSelect(): void;
}

export function ActionsMenu({
  items,
  label,
  menuLabel,
}: {
  readonly items: readonly MenuAction[];
  /** The button's accessible name: "More actions". */
  readonly label: string;
  /** The menu's accessible name: "Ticket actions". */
  readonly menuLabel: string;
}): ReactNode {
  const tokens = useSemanticTokens();
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { locale } = usePreferences();
  const end = dir(locale) === 'rtl' ? 'left' : 'right';

  const close = (): void => {
    setAnchor(null);
  };

  return (
    <>
      <IconButton
        size="small"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-controls={anchor === null ? undefined : menuId}
        disabled={items.length === 0}
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
        onClose={close}
        // Aligned to the button's inline end. MUI's origins are physical, so
        // the direction picks the side, as the details drawer's anchor does.
        anchorOrigin={{ vertical: 'bottom', horizontal: end }}
        transformOrigin={{ vertical: 'top', horizontal: end }}
        slotProps={{
          list: { 'aria-label': menuLabel, dense: true },
          paper: { sx: { width: 240, padding: '6px', borderRadius: '10px' } },
        }}
      >
        {/* A flat list rather than fragments: MUI's menu reads its children to
            move focus with the arrow keys, and a fragment hides them. */}
        {items.flatMap((item, index) => [
          // Never above the first item: a divider separates.
          ...(item.dividerBefore === true && index > 0
            ? [<Divider key={`${item.id}-divider`} sx={{ marginBlock: 1 }} />]
            : []),
          <MenuItem
            key={item.id}
            onClick={() => {
              close();
              item.onSelect();
            }}
            sx={{
              minHeight: 32,
              borderRadius: '4px',
              fontSize: 13,
              gap: 2,
              color: item.tone === 'danger' ? tokens['status.danger.text'] : 'text.primary',
            }}
          >
            <ListItemIcon sx={{ minWidth: 0, color: 'inherit' }}>
              <item.icon size={16} aria-hidden="true" />
            </ListItemIcon>
            {item.label}
          </MenuItem>,
        ])}
      </Menu>
    </>
  );
}
