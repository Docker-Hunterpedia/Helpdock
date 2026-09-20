import type { Attachment } from '@helpdock/schemas';
import { useEffect, useState } from 'react';
import type { RealtimeClient } from '../realtime/client.js';
import type { AttachmentUploader } from './upload.js';

/**
 * Watches one attachment until the media pipeline is finished with it (M1-10).
 *
 * Two sources, and the order between them is DOMAIN-RULES §7's: **the socket is
 * a notification and REST is the truth.** An `attachment:changed` frame does
 * not carry the row — it cannot, because it would have to carry a presigned URL
 * with it and a URL broadcast to a room outlives the check that issued it — so
 * the frame only says "look again", and the look is a REST read.
 *
 * The poll underneath it is the guarantee. Socket.IO does not promise delivery,
 * a tab may have been asleep, and a composer that waits for a frame that never
 * comes is a spinner that never stops. It backs off, and it stops the moment
 * the row reaches a state that will not change.
 */

/** First gap between polls. Most images are done inside one of these. */
export const POLL_START_MS = 1_000;
/** The longest gap it will wait. A video with a poster to cut is the slow case. */
export const POLL_MAX_MS = 8_000;
/** Give up after this long and let the caller offer a retry. */
export const POLL_TIMEOUT_MS = 180_000;

export interface AttachmentWatch {
  readonly attachment: Attachment | undefined;
  /** True while the row is `pending` or `processing`. */
  readonly settling: boolean;
  /** Set when the watch gave up, so a placeholder can offer to look again. */
  readonly timedOut: boolean;
}

/** A row the pipeline will not move again. */
export const isSettled = (attachment: Attachment | undefined): boolean =>
  attachment !== undefined && attachment.status !== 'pending' && attachment.status !== 'processing';

export interface UseAttachmentOptions {
  readonly brandId: string;
  readonly ticketId: string;
  readonly attachmentId: string;
  readonly uploader: AttachmentUploader;
  /** Optional: with one, a frame cuts the wait short. Without one, it polls. */
  readonly realtime?: RealtimeClient;
  /** The row the caller already has, so a settled attachment never polls at all. */
  readonly initial?: Attachment;
  /** The three gaps above, overridable so a test need not wait a real second. */
  readonly timing?: {
    readonly startMs?: number;
    readonly maxMs?: number;
    readonly timeoutMs?: number;
  };
}

export function useAttachment({
  brandId,
  ticketId,
  attachmentId,
  uploader,
  realtime,
  initial,
  timing,
}: UseAttachmentOptions): AttachmentWatch {
  const startMs = timing?.startMs ?? POLL_START_MS;
  const maxMs = timing?.maxMs ?? POLL_MAX_MS;
  const timeoutMs = timing?.timeoutMs ?? POLL_TIMEOUT_MS;
  const [attachment, setAttachment] = useState<Attachment | undefined>(initial);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (isSettled(initial)) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = startMs;
    const deadline = Date.now() + timeoutMs;

    const read = async (): Promise<void> => {
      let next: Attachment;
      try {
        next = await uploader.status(brandId, ticketId, attachmentId);
      } catch {
        // A read that failed is not a verdict. Try again on the next tick; the
        // deadline is what ends this, not one bad response.
        schedule();
        return;
      }

      if (cancelled) {
        return;
      }

      setAttachment(next);
      if (!isSettled(next)) {
        schedule();
      }
    };

    function schedule(): void {
      if (cancelled) {
        return;
      }
      if (Date.now() >= deadline) {
        setTimedOut(true);
        return;
      }

      timer = setTimeout(() => void read(), delay);
      delay = Math.min(delay * 2, maxMs);
    }

    schedule();

    // A frame short-circuits the wait; it never replaces the read, because the
    // frame carries no URL and no variants.
    const unsubscribe = realtime?.subscribe({
      attachmentChanged: (change) => {
        if (change.attachmentId === attachmentId) {
          void read();
        }
      },
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [brandId, ticketId, attachmentId, uploader, realtime, initial, startMs, maxMs, timeoutMs]);

  return { attachment, settling: !isSettled(attachment), timedOut };
}
