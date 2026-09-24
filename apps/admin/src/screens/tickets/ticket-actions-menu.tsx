import { Divider, IconButton, ListItemIcon, Menu, MenuItem } from '@mui/material';
import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The ⋯ button beside Close in the ticket header, and the menu it opens
 * (`Admin · ticket dialogs`, panel 2).
 *
 * **The menu is data.** Each deliverable that owns an action — merge and split
 * (M1-09), log time (M1-12), mark as spam (M1-11) — contributes an item to one
 * array, in the artboard's order; this component draws whatever it is handed.
 * An item that is `danger` is drawn in the danger text colour and is expected
 * last, behind a separator, as "Mark as spam" is on the artboard.
 *
 * With nothing to offer, the button is drawn disabled rather than hidden, so
 * the header does not change shape between one ticket and the next.
 */

export interface TicketMenuItem {
  /** Stable, and unique within the menu. */
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The artboard draws the destructive action in danger text. */
  readonly tone?: 'danger';
  /**
   * A separator above this item, as the artboard draws above "Mark as spam".
   * Ignored on the first item.
   */
  readonly separatorBefore?: boolean;
  onSelect(): void;
}

export function TicketActionsMenu({
  items,
}: {
  readonly items: readonly TicketMenuItem[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <IconButton
        size="small"
        aria-label={t('tickets:header.more')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={items.length === 0}
        onClick={(event) => {
          setAnchor(event.currentTarget);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </IconButton>

      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null);
        }}
        slotProps={{
          list: { 'aria-label': t('tickets:header.menu') },
          paper: { sx: { width: 240, borderRadius: '10px' } },
        }}
      >
        {/* A flat list rather than fragments: MUI's menu reads its children to
            move focus with the arrow keys, and a fragment hides them. */}
        {items.flatMap((item, index) => [
          // Never above the first item: a separator separates.
          ...(item.separatorBefore === true && index > 0
            ? [<Divider key={`${item.key}-separator`} sx={{ marginBlock: 1 }} />]
            : []),
          <MenuItem
            key={item.key}
            sx={{
              fontSize: 13,
              minHeight: 32,
              ...(item.tone === 'danger' ? { color: tokens['status.danger.text'] } : {}),
            }}
            onClick={() => {
              setAnchor(null);
              item.onSelect();
            }}
          >
            <ListItemIcon sx={{ color: 'inherit' }}>
              <item.icon size={16} aria-hidden="true" />
            </ListItemIcon>
            {item.label}
          </MenuItem>,
        ])}
      </Menu>
    </>
  );
}
