import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useLocation } from 'react-router';
import { currentBrand, useSession } from '../auth/session.tsx';
import { CommandPalette } from './command-palette.tsx';
import { recentAt } from './model.js';
import { remember } from './recents.js';

/**
 * Owns the command palette's open state for the signed-in shell (M14-05), so
 * the `⌘K` shortcut, the sidebar's Search and a test can all open the one
 * palette. It also writes the recents: every ticket, contact or settings page
 * the person lands on, however they got there, so the empty palette is a
 * history and not only a list of what they picked from it.
 */
interface PaletteContextValue {
  readonly open: () => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

/** Outside a provider, opening does nothing, so a component can be rendered on its own. */
export const usePalette = (): PaletteContextValue =>
  useContext(PaletteContext) ?? { open: () => {} };

export function PaletteProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [isOpen, setOpen] = useState(false);
  const session = useSession();
  const { pathname } = useLocation();
  const userId = session.user.id;
  const brandId = currentBrand(session).id;

  useEffect(() => {
    const visited = recentAt(pathname);
    if (visited !== null) {
      remember(userId, brandId, visited);
    }
  }, [pathname, userId, brandId]);

  const open = useCallback(() => {
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <CommandPalette
        open={isOpen}
        onClose={() => {
          setOpen(false);
        }}
      />
    </PaletteContext.Provider>
  );
}
