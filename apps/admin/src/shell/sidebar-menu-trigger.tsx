import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * The two full-width buttons the sidebar opens a menu from: the brand switcher
 * at the top and the current user at the bottom (DESIGN §6.5). A real `button`
 * so it is reachable by Tab and answers Enter and Space on its own.
 */
export function SidebarMenuTrigger({
  label,
  menuId,
  open,
  onOpen,
  children,
}: {
  /** The accessible name; the visible text is whatever `children` renders. */
  readonly label: string;
  readonly menuId: string;
  readonly open: boolean;
  readonly onOpen: (anchor: HTMLElement) => void;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="button"
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={label}
      onClick={(event) => {
        onOpen(event.currentTarget);
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        width: '100%',
        padding: 2,
        border: 0,
        borderRadius: '6px',
        backgroundColor: 'transparent',
        cursor: 'pointer',
        textAlign: 'start',
        font: 'inherit',
        color: 'inherit',
        '&:hover': { backgroundColor: tokens['bg.muted'] },
      }}
    >
      {children}
    </Box>
  );
}
