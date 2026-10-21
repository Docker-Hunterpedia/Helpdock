import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useT } from '../app/i18n.js';
import { currentBrand, useSession, useTicketsApi } from '../auth/session.tsx';
import { useToast } from '../ui/toasts.tsx';
import { failureOf } from './bulk.js';
import { ticketKeys } from './keys.js';

/**
 * The last bulk edit the person made and may still undo (M14-04).
 *
 * The toast that follows an apply offers Undo for ten seconds; the api accepts
 * it for sixty, and "Undo last bulk change" in the command palette is how the
 * rest of that minute is reached, from any screen. So the operation is held
 * here, above the palette and the ticket workspace both, until its window
 * closes, the person switches brand, or it has been undone.
 *
 * Only one is kept: a second edit while the first is still undoable replaces it,
 * which is what "last" means. The api would still undo the earlier one by id.
 */

export interface LastBulk {
  readonly brandId: string;
  readonly operationId: string;
  /** Epoch milliseconds the api stops accepting the undo. */
  readonly until: number;
}

interface BulkUndoValue {
  /** Whether there is something to undo right now. */
  readonly available: boolean;
  record(last: LastBulk): void;
  /** Undoes the held operation; resolves once it has been tried and the person told. */
  undo(): Promise<void>;
}

const NOTHING: BulkUndoValue = {
  available: false,
  record: () => {},
  undo: () => Promise.resolve(),
};

const BulkUndoContext = createContext<BulkUndoValue>(NOTHING);

/** Outside a provider nothing is held, so a component can be rendered on its own. */
export const useBulkUndo = (): BulkUndoValue => useContext(BulkUndoContext);

export function BulkUndoProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const t = useT();
  const toast = useToast();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const brandId = currentBrand(useSession()).id;
  const [last, setLast] = useState<LastBulk | null>(null);
  // The toast's Undo is made in the render that applied, before `last` has
  // been committed, so it must read the latest through a ref, not a closure.
  const held = useRef<LastBulk | null>(null);
  const undoing = useRef(false);
  const hold = useCallback((next: LastBulk | null): void => {
    held.current = next;
    setLast(next);
  }, []);

  // The window closes by itself, and so does the palette entry.
  useEffect(() => {
    if (last === null) {
      return;
    }
    const timer = setTimeout(
      () => {
        hold(null);
      },
      Math.max(0, last.until - Date.now()),
    );

    return () => {
      clearTimeout(timer);
    };
  }, [last, hold]);

  const available = last !== null && last.brandId === brandId;

  const undo = useCallback(async (): Promise<void> => {
    const target = held.current;
    if (target === null || undoing.current) {
      return;
    }
    undoing.current = true;
    try {
      const result = await api.undoBulk(target.brandId, target.operationId);
      const reverted = result.results.filter((item) => item.reverted.length > 0).length;
      const kept = result.results.filter((item) => item.kept.length > 0).length;
      toast({
        tone: 'success',
        message:
          kept === 0
            ? t('tickets:bulk.undo.done', { count: reverted })
            : t('tickets:bulk.undo.partly', { count: kept }),
      });
      hold(null);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.kind === 'expired' || failure.kind === 'alreadyUndone') {
        hold(null);
      }
      toast({
        tone: 'danger',
        message:
          failure.kind === 'expired'
            ? t('tickets:bulk.undo.expired')
            : failure.kind === 'alreadyUndone'
              ? t('tickets:bulk.undo.already')
              : failure.kind === 'rateLimited'
                ? t('tickets:bulk.error.rateLimited')
                : t('tickets:bulk.undo.failed'),
      });
    } finally {
      undoing.current = false;
      await queryClient.invalidateQueries({ queryKey: ticketKeys.brand(target.brandId) });
    }
  }, [api, hold, queryClient, t, toast]);

  const value = useMemo<BulkUndoValue>(
    () => ({ available, record: hold, undo }),
    [available, hold, undo],
  );

  return <BulkUndoContext.Provider value={value}>{children}</BulkUndoContext.Provider>;
}
