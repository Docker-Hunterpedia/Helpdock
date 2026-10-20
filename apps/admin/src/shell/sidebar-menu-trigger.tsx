import { Box } from '@mui/material';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * The two buttons the sidebar opens a menu from: the brand switcher at the top
 * and the current user at the bottom (DESIGN §6.5). A real `button` so it is
 * reachable by Tab and answers Enter and Space on its own.
 *
 * `row` is the full-width row of the expanded sidebar; `square` is the 36 px
 * icon of the collapsed rail. Any other attribute, and the ref, reach the
 * button, so a Tooltip can wrap it.
 */
export function SidebarMenuTrigger({
  label,
  menuId,
  open,
  onOpen,
  shape = 'row',
  children,
  ...rest
}: {
  /** The accessible name; the visible text is whatever `children` renders. */
  readonly label: string;
  readonly menuId: string;
  readonly open: boolean;
  readonly onOpen: (anchor: HTMLElement) => void;
  readonly shape?: 'row' | 'square';
  readonly children: ReactNode;
} & Omit<ComponentPropsWithRef<'button'>, 'children' | 'onClick' | 'type'>): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      {...rest}
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
        ...(shape === 'row'
          ? { width: '100%', padding: 2 }
          : { width: 36, height: 36, padding: 0, justifyContent: 'center' }),
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
