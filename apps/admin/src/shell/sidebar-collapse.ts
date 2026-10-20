import { useMediaQuery } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the admin sidebar is the 220 px column or the 56 px icon rail
 * (1.0.2, `Admin/Shell-SidebarCollapse`).
 *
 * The person's choice is remembered per browser. Until they make one, the
 * viewport decides: expanded from 1280 px, the rail between 1024 and 1279 px.
 * Below 1024 px the sidebar is the drawer, which is never collapsed.
 */

export const SIDEBAR_STORAGE_KEY = 'helpdock.admin.sidebar';

export type SidebarState = 'expanded' | 'collapsed';

const ROOMY_VIEWPORT = '(min-width:1280px)';

/**
 * Storage throws when site data is blocked, and the shell still has to draw:
 * a choice that cannot be read is no choice, and one that cannot be written is
 * simply not remembered.
 */
export function readSidebarChoice(): SidebarState | null {
  try {
    const stored = globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) ?? null;
    return stored === 'expanded' || stored === 'collapsed' ? stored : null;
  } catch {
    return null;
  }
}

export function storeSidebarChoice(state: SidebarState): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, state);
  } catch {
    // Not remembering the choice is better than failing the toggle.
  }
}

export interface ShortcutKeys {
  readonly key: string;
  /** The physical key, so the shortcut sits in the same place on an Arabic layout. */
  readonly code?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * ⌘\ on a Mac, Ctrl+\ elsewhere; either modifier is taken on any platform.
 * Matched by the physical `Backslash` key first, as the ticket shortcuts are
 * (`screens/tickets/keyboard.ts`), and by the character for a layout that puts
 * the backslash on another key. It carries a modifier, so it is a shortcut
 * even while somebody is typing in a field.
 */
export const isSidebarShortcut = (event: ShortcutKeys): boolean =>
  (event.metaKey === true || event.ctrlKey === true) &&
  event.altKey !== true &&
  event.shiftKey !== true &&
  (event.code === 'Backslash' || event.key === '\\');

/**
 * The sidebar's state and its toggle. `shortcut` is whether ⌘\ answers here:
 * only where the sidebar is a column, since a toggle nobody can see would
 * silently change the remembered choice.
 */
export function useSidebarCollapse({ shortcut }: { readonly shortcut: boolean }): {
  readonly collapsed: boolean;
  readonly toggle: () => void;
} {
  const roomy = useMediaQuery(ROOMY_VIEWPORT, { noSsr: true });
  const [choice, setChoice] = useState<SidebarState | null>(readSidebarChoice);
  const collapsed = (choice ?? (roomy ? 'expanded' : 'collapsed')) === 'collapsed';

  const toggle = useCallback(() => {
    const next: SidebarState = collapsed ? 'expanded' : 'collapsed';
    setChoice(next);
    storeSidebarChoice(next);
  }, [collapsed]);

  useEffect(() => {
    if (!shortcut) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isSidebarShortcut(event)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [shortcut, toggle]);

  return { collapsed, toggle };
}
