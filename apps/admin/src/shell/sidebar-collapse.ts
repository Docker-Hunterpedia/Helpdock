import { useMediaQuery } from '@mui/material';
import { useCallback, useState } from 'react';

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

/**
 * The sidebar's state and its toggle. The keys that toggle it — `b`, and ⌘\
 * on a Mac or Ctrl+\ elsewhere — are in the shortcut registry
 * (`keyboard/registry.ts`); the shell attaches this toggle to them only where
 * the sidebar is a column, since a toggle nobody can see would silently
 * change the remembered choice.
 */
export function useSidebarCollapse(): {
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

  return { collapsed, toggle };
}
