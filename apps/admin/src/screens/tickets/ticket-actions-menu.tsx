import { dir } from '@helpdock/i18n';
import { Divider, IconButton, ListItemIcon, Menu, MenuItem } from '@mui/material';
import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The ⋯ menu beside the header's buttons — panel 2 of `AdminTicketDialogs`.
 *
 * It draws whatever `items` it is given, in order, so the deliverables that add
 * to it each add an entry rather than edit this file: M1-09 passes Merge and
 * Split, M1-12 adds Log time when time tracking is on, M1-11 adds Mark as spam
 * last, in danger, after a divider. The artboard fixes that order; the caller
 * owns it.
 *
 * An empty list draws the button disabled rather than a menu with nothing in
 * it, which is what a Viewer — who may edit nothing — sees.
 */

export interface TicketAction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Danger text, for an item that throws work away (DESIGN §6.4 Menu). */
  readonly tone?: 'danger';
  /** A 1 px divider above this item, which is how the artboard sets spam apart. */
  readonly dividerBefore?: boolean;
  onSelect(): void;
}

export function TicketActionsMenu({
  items,
}: {
  readonly items: readonly TicketAction[];
}): ReactNode {
  const t = useT();
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
        aria-label={t('tickets:header.more')}
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
          list: { 'aria-label': t('tickets:actions.label'), dense: true },
          paper: { sx: { width: 240, padding: '6px', borderRadius: '10px' } },
        }}
      >
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.dividerBefore === true ? <Divider sx={{ marginBlock: 1 }} /> : null}
            <MenuItem
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
            </MenuItem>
          </Fragment>
        ))}
      </Menu>
    </>
  );
}
