import { useMutation } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../app/i18n.js';
import { useSession, useUpdateSessionUser } from '../auth/session.tsx';
import { ADMIN_NAV, NAV_BY_KEY, navFor } from '../shell/nav-items.js';
import { useToast } from '../ui/toasts.tsx';
import type { KeyboardApi } from './api.js';
import { type PendingSequence, resolveShortcut, SEQUENCE_WINDOW_MS } from './dispatch.js';
import { ariaStroke, isInOverlay, isTyping } from './keys.js';
import { isSequence, type ShortcutId, type ShortcutPermission, shortcutById } from './registry.js';
import { SequenceChip } from './sequence-chip.tsx';
import { ShortcutSheet } from './shortcut-sheet.tsx';

/**
 * The one listener every shortcut goes through (M14-01).
 *
 * A screen attaches what a shortcut does with {@link useShortcutHandlers}, by
 * id, for as long as it is mounted; this provider owns the `keydown` listener,
 * decides with `resolveShortcut` which shortcut a press is, and calls the
 * handler attached last for it. It also holds the single-key switch, read from
 * the session and saved to the account, the `?` sheet and the chip that shows while a `g`
 * sequence waits.
 */

export type ShortcutHandler = () => void;

interface KeyboardContextValue {
  register(id: ShortcutId, run: ShortcutHandler): () => void;
  readonly singleKeys: boolean;
  setSingleKeys(on: boolean): void;
  openSheet(): void;
  permits(permission: ShortcutPermission | undefined): boolean;
}

const KeyboardContext = createContext<KeyboardContextValue | null>(null);
const KeyboardApiContext = createContext<KeyboardApi | null>(null);

export function KeyboardApiProvider({
  api,
  children,
}: {
  readonly api: KeyboardApi;
  readonly children: ReactNode;
}): ReactNode {
  return <KeyboardApiContext.Provider value={api}>{children}</KeyboardApiContext.Provider>;
}

const useKeyboardApi = (): KeyboardApi => {
  const api = useContext(KeyboardApiContext);
  if (!api) {
    throw new Error('the keyboard needs a <KeyboardApiProvider> above it');
  }
  return api;
};

/** On when the session does not say, which is the default (D-32). */
const SINGLE_KEYS_BY_DEFAULT = true;

/**
 * The single-key switch: read from the session, which the shell has before it
 * draws, so no letter is taken before the person's choice is known (WCAG
 * 2.1.4); saved to the account and written back into the session.
 */
function useSingleKeySwitch(): {
  readonly singleKeys: boolean;
  /** A save is on its way to the account; the switch says so with `aria-busy`. */
  readonly saving: boolean;
  readonly setSingleKeys: (on: boolean) => void;
} {
  const t = useT();
  const toast = useToast();
  const api = useKeyboardApi();
  const updateUser = useUpdateSessionUser();
  const singleKeys = useSession().user.singleKeyShortcuts ?? SINGLE_KEYS_BY_DEFAULT;

  // Optimistic, so the sheet's rows grey out as the switch moves; a refusal
  // puts the switch back where the account still has it.
  const save = useMutation({
    mutationFn: (on: boolean) => api.save({ singleKeyShortcuts: on }),
    onMutate: (on) => {
      updateUser({ singleKeyShortcuts: on });
    },
    onError: (_error, on) => {
      updateUser({ singleKeyShortcuts: !on });
      toast({ tone: 'danger', message: t('tickets:keyboard.saveFailed') });
    },
  });

  const { mutate, isPending } = save;
  const setSingleKeys = useCallback(
    (on: boolean) => {
      // One save at a time, so two quick toggles cannot land out of order.
      if (!isPending) {
        mutate(on);
      }
    },
    [mutate, isPending],
  );

  return { singleKeys, saving: isPending, setSingleKeys };
}

/** Whether the signed-in person may use a shortcut that needs `permission`. */
function usePermits(): (permission: ShortcutPermission | undefined) => boolean {
  const viewer = useSession().user;
  return useCallback(
    (permission: ShortcutPermission | undefined): boolean => {
      switch (permission) {
        case undefined:
          return true;
        case 'ticket:write':
          return viewer.role !== 'viewer';
        case 'report:read':
          return navFor([NAV_BY_KEY.reports], viewer).length > 0;
        case 'settings':
          return navFor(ADMIN_NAV, viewer).length > 0;
      }
    },
    [viewer],
  );
}

export function KeyboardProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const handlers = useRef(new Map<ShortcutId, ShortcutHandler[]>());
  const [pending, setPending] = useState<PendingSequence | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { singleKeys, saving, setSingleKeys } = useSingleKeySwitch();
  const permits = usePermits();

  // Read when a key arrives rather than closed over when the listener was
  // attached, so the listener is attached once.
  const latest = useRef({ singleKeys, permits, pending });
  useLayoutEffect(() => {
    latest.current = { singleKeys, permits, pending };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A control that used the key itself (a menu's type-ahead) keeps it,
      // and so does an input method composing a character (an IME).
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const { target } = event;
      const now = Date.now();
      const result = resolveShortcut(event, latest.current.pending, {
        now,
        singleKeys: latest.current.singleKeys,
        typing: isTyping(target),
        inOverlay: isInOverlay(target),
        inComposer:
          target instanceof Element && target.closest('[data-shortcut-scope="composer"]') !== null,
        available: (id) =>
          (handlers.current.get(id)?.length ?? 0) > 0 &&
          latest.current.permits(shortcutById(id).permission),
      });

      latest.current = { ...latest.current, pending: result.pending };
      setPending(result.pending);
      if (result.consumed) {
        event.preventDefault();
      }
      if (result.id !== null) {
        handlers.current.get(result.id)?.at(-1)?.();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // The chip goes when the sequence's window does.
  useEffect(() => {
    if (pending === null) {
      return;
    }
    const timer = setTimeout(() => {
      latest.current = { ...latest.current, pending: null };
      setPending(null);
    }, SEQUENCE_WINDOW_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pending]);

  const register = useCallback((id: ShortcutId, run: ShortcutHandler) => {
    const attached = handlers.current.get(id) ?? [];
    handlers.current.set(id, [...attached, run]);
    return () => {
      handlers.current.set(
        id,
        (handlers.current.get(id) ?? []).filter((candidate) => candidate !== run),
      );
    };
  }, []);

  const value = useMemo<KeyboardContextValue>(
    () => ({
      register,
      singleKeys,
      setSingleKeys,
      openSheet: () => {
        setSheetOpen(true);
      },
      permits,
    }),
    [register, singleKeys, setSingleKeys, permits],
  );

  return (
    <KeyboardContext.Provider value={value}>
      {children}
      <ShortcutSheet
        open={sheetOpen}
        singleKeys={singleKeys}
        saving={saving}
        permits={permits}
        onSingleKeysChange={setSingleKeys}
        onClose={() => {
          setSheetOpen(false);
        }}
      />
      <SequenceChip pending={pending} permits={permits} />
    </KeyboardContext.Provider>
  );
}

/**
 * Attaches what each shortcut in `handlers` does while the calling component
 * is mounted. A null handler attaches nothing, which is how a screen says a
 * shortcut does not apply right now (no ticket open, a reader who cannot
 * write). The type takes exactly the ids of the list a screen declares, so a
 * shortcut it lists cannot be left without a handler.
 *
 * Outside a {@link KeyboardProvider} it does nothing, so a component can be
 * rendered on its own in a test.
 */
export function useShortcutHandlers<Id extends ShortcutId>(
  handlers: {
    readonly [K in Id]: ShortcutHandler | null;
  },
): void {
  // The register function alone, which is stable, so a change of the switch
  // or of the sheet does not detach and re-attach every handler.
  const register = useContext(KeyboardContext)?.register ?? null;
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  const attached = (Object.keys(handlers) as Id[])
    .filter((id) => handlers[id] !== null)
    .sort()
    .join(' ');

  useEffect(() => {
    if (register === null || attached === '') {
      return;
    }
    const detach = (attached.split(' ') as Id[]).map((id) =>
      register(id, () => {
        latest.current[id]?.();
      }),
    );
    return () => {
      for (const undo of detach) {
        undo();
      }
    };
  }, [register, attached]);
}

/**
 * The switch and whether a shortcut answers now, for the controls that
 * advertise a shortcut (`aria-keyshortcuts`) and the hints that print one.
 */
export function useKeyboard(): {
  readonly singleKeys: boolean;
  readonly openSheet: () => void;
  readonly permits: (permission: ShortcutPermission | undefined) => boolean;
} {
  const context = useContext(KeyboardContext);
  return {
    singleKeys: context?.singleKeys ?? SINGLE_KEYS_BY_DEFAULT,
    openSheet: context?.openSheet ?? (() => {}),
    permits: context?.permits ?? (() => true),
  };
}

/**
 * The `aria-keyshortcuts` of the control a shortcut stands for, or undefined
 * when it does not answer for this person right now (off by the switch, not
 * theirs to use). A sequence has no value: the attribute names chords, and a
 * space in it means "or", not "then".
 */
export function useAriaKeyShortcuts(id: ShortcutId): string | undefined {
  const { singleKeys, permits } = useKeyboard();
  const shortcut = shortcutById(id);
  if (isSequence(shortcut) || !permits(shortcut.permission)) {
    return undefined;
  }
  const answering = [shortcut.keys, ...(shortcut.alternates ?? [])].flatMap((strokes) => {
    const first = strokes[0];
    return first !== undefined && (singleKeys || first.mod === true) ? [ariaStroke(first)] : [];
  });
  return answering.length === 0 ? undefined : answering.join(' ');
}
