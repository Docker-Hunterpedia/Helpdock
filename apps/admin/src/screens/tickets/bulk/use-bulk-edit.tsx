import type { BulkResponse } from '@helpdock/schemas';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useTicketsApi } from '../../../auth/session.tsx';
import {
  type BulkChoice,
  changesOf,
  failureOf,
  type PreviewSummary,
  summarise,
  toastKindOf,
} from '../../../tickets/bulk.js';
import { useBulkUndo } from '../../../tickets/bulk-undo.tsx';
import { ticketKeys } from '../../../tickets/keys.js';
import { useToast } from '../../../ui/toasts.tsx';

/**
 * The bulk edit as a flow (M14-04): preview, then apply, then an Undo.
 *
 * `start(choice)` previews the ticked tickets. If every one would change it
 * applies at once; otherwise it opens the review, which lists what cannot, and
 * `confirm()` applies the ones that can. An apply is all or nothing against the
 * preview it names, so when the api answers `bulk-changed` (409) the flow
 * previews again and shows the review with a note that the list moved, rather
 * than applying a set the person has not seen. A 429 closes the review with the
 * wait; any other failure says nothing was changed.
 *
 * Success clears the selection (`onDone`), hands the operation to the undo
 * provider, which the palette reads, and shows "Closed 10 tickets · Undo".
 */

export interface Review {
  readonly choice: BulkChoice;
  readonly summary: PreviewSummary;
  /** Previewed again after a `bulk-changed`. */
  readonly refreshed: boolean;
}

export function useBulkEdit({
  brandId,
  ticketIds,
  onDone,
}: {
  readonly brandId: string;
  /** The ticked tickets, in list order. */
  readonly ticketIds: readonly string[];
  onDone(): void;
}): {
  readonly busy: boolean;
  readonly applying: boolean;
  readonly review: Review | null;
  start(choice: BulkChoice): void;
  confirm(): void;
  cancel(): void;
} {
  const t = useT();
  const api = useTicketsApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const undo = useBulkUndo();
  const [working, setWorking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  // A second click while a request is out would send a second preview or apply.
  const inFlight = useRef(false);
  // Which request a failure belongs to: an apply can follow a preview in one `start`.
  const step = useRef<'preview' | 'apply'>('preview');

  const tell = useCallback(
    (message: string): void => {
      toast({ tone: 'danger', message });
    },
    [toast],
  );

  /** What a failure other than `bulk-changed` says; the review is closed either way. */
  const fail = useCallback(
    (error: unknown, step: 'preview' | 'apply'): void => {
      const failure = failureOf(error);
      setReview(null);
      if (failure.kind === 'rateLimited') {
        tell(
          failure.retryAfter === undefined
            ? t('tickets:bulk.error.rateLimited')
            : t('tickets:bulk.error.rateLimitedIn', { count: failure.retryAfter }),
        );
      } else if (step === 'apply' && failure.kind === 'unknown') {
        // The apply may have committed with its answer lost on the way back, so
        // "nothing was changed" would be a guess: say so, and read the list again.
        tell(t('tickets:bulk.error.unknown'));
        void queryClient.invalidateQueries({ queryKey: ticketKeys.brand(brandId) });
      } else {
        tell(
          t(step === 'preview' ? 'tickets:bulk.error.previewFailed' : 'tickets:bulk.error.failed'),
        );
      }
    },
    [brandId, queryClient, t, tell],
  );

  const apply = useCallback(
    async (choice: BulkChoice, changing: readonly string[]): Promise<void> => {
      step.current = 'apply';
      setApplying(true);
      const response: BulkResponse = await api.bulk(brandId, {
        ticketIds: [...ticketIds],
        changes: changesOf(choice),
        mode: 'apply',
        expect: [...changing],
      });
      setReview(null);
      onDone();
      await queryClient.invalidateQueries({ queryKey: ticketKeys.brand(brandId) });
      if (response.operationId !== null && response.undoUntil !== null) {
        undo.record({
          brandId,
          operationId: response.operationId,
          until: Date.parse(response.undoUntil),
        });
      }
      toast({
        tone: 'success',
        message: t(`tickets:bulk.toast.${toastKindOf(choice)}`, {
          count: response.counts.willChange,
        }),
        ...(response.operationId === null
          ? {}
          : {
              action: {
                label: t('tickets:bulk.toast.undo'),
                onClick: () => {
                  void undo.undo();
                },
              },
            }),
      });
    },
    [api, brandId, onDone, queryClient, t, ticketIds, toast, undo],
  );

  /** Previews, and applies at once when every ticket would change and nothing was refreshed. */
  const preview = useCallback(
    async (choice: BulkChoice, refreshed: boolean): Promise<void> => {
      const response = await api.bulk(brandId, {
        ticketIds: [...ticketIds],
        changes: changesOf(choice),
        mode: 'preview',
      });
      const summary = summarise(response);
      if (!refreshed && summary.blockers.length === 0 && summary.changing.length > 0) {
        await apply(choice, summary.changing);
        return;
      }
      setReview({ choice, summary, refreshed });
    },
    [api, apply, brandId, ticketIds],
  );

  const attempt = useCallback(
    async (choice: BulkChoice, changing: readonly string[] | null): Promise<void> => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      step.current = changing === null ? 'preview' : 'apply';
      setWorking(true);
      try {
        try {
          await (changing === null ? preview(choice, false) : apply(choice, changing));
        } catch (error) {
          if (failureOf(error).kind !== 'changed') {
            throw error;
          }
          // Something previewed was edited meanwhile: look again, and show it.
          setApplying(false);
          step.current = 'preview';
          try {
            await preview(choice, true);
          } catch (again) {
            fail(again, 'preview');
          }
        }
      } catch (error) {
        fail(error, step.current);
      } finally {
        inFlight.current = false;
        setApplying(false);
        setWorking(false);
      }
    },
    [apply, fail, preview],
  );

  return {
    busy: working,
    applying,
    review,
    start: (choice) => {
      void attempt(choice, null);
    },
    confirm: () => {
      if (review !== null) {
        void attempt(review.choice, review.summary.changing);
      }
    },
    cancel: () => {
      setReview(null);
    },
  };
}
