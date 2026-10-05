import type { AiFeedback, Attachment, WidgetMessage } from '../transport/types.js';

/**
 * The visitor's view of one conversation under the delivery contract in
 * DOMAIN-RULES §7, as a pure reducer so every rule is unit-testable:
 *
 * - A message is **sent** only once it holds a `seq`. Until then it is a
 *   pending entry keyed by its `client_id`, either `sending` or `failed`.
 * - Messages are deduplicated by `seq`, and a confirmed message replaces the
 *   pending entry with the same `client_id`, whichever path (send response,
 *   socket event, catch-up) delivered it first.
 * - `lastSeq` is the cursor for `GET …/messages?after=`. A live event that
 *   skips past `lastSeq + 1` is a gap: it is kept, but the cursor does not
 *   move and the caller must catch up. A catch-up answer is authoritative, so
 *   the cursor jumps to the highest `seq` it returned; `seq` values the
 *   visitor never sees (internal notes) therefore cannot cause a loop.
 */
export type PendingStatus = 'sending' | 'failed';

export interface PendingMessage {
  readonly client_id: string;
  readonly body: string;
  readonly attachments: readonly Attachment[];
  readonly status: PendingStatus;
  readonly created_at: string;
}

export interface ThreadState {
  /** Ordered by `seq`, unique. */
  readonly confirmed: readonly WidgetMessage[];
  /** In the order the visitor sent them; always drawn after `confirmed`. */
  readonly pending: readonly PendingMessage[];
  readonly lastSeq: number;
  readonly readSeq: number;
}

/** M7-06: the visitor's "Was this helpful?" on an assistant answer, shown at once. */
export const setFeedback = (
  state: ThreadState,
  messageId: string,
  feedback: AiFeedback,
): ThreadState => ({
  ...state,
  confirmed: state.confirmed.map((message) =>
    message.id === messageId && message.ai
      ? { ...message, ai: { ...message.ai, feedback } }
      : message,
  ),
});

/**
 * M7-06: whether the assistant is answering this thread — it has written, and
 * nobody has taken over since — which is when "Talk to a human" is offered.
 */
export const assistantAnswering = (state: ThreadState, handedOff: boolean): boolean => {
  if (handedOff) {
    return false;
  }
  const last = state.confirmed.findLast((message) => message.author.kind !== 'visitor');
  return last?.author.kind === 'ai' && last.ai?.kind === 'answer';
};

export interface ApplyResult {
  readonly state: ThreadState;
  /** The caller must fetch `after=state.lastSeq`. */
  readonly gap: boolean;
  /** Messages this call added that were not already in the thread. */
  readonly added: readonly WidgetMessage[];
}

export const emptyThread: ThreadState = { confirmed: [], pending: [], lastSeq: 0, readSeq: 0 };

function merge(
  state: ThreadState,
  incoming: readonly WidgetMessage[],
): { confirmed: WidgetMessage[]; pending: PendingMessage[]; added: WidgetMessage[] } {
  const bySeq = new Map(state.confirmed.map((message) => [message.seq, message]));
  const added: WidgetMessage[] = [];

  for (const message of incoming) {
    if (!bySeq.has(message.seq)) {
      bySeq.set(message.seq, message);
      added.push(message);
    }
  }

  const confirmedIds = new Set(
    [...bySeq.values()].map((message) => message.client_id).filter((id) => id !== null),
  );

  return {
    confirmed: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    pending: state.pending.filter((entry) => !confirmedIds.has(entry.client_id)),
    added,
  };
}

/** A socket event or a send response: one message whose neighbours may be missing. */
export function applyLive(state: ThreadState, message: WidgetMessage): ApplyResult {
  const { confirmed, pending, added } = merge(state, [message]);
  const known = new Set(confirmed.map((entry) => entry.seq));

  let lastSeq = state.lastSeq;
  while (known.has(lastSeq + 1)) {
    lastSeq += 1;
  }

  return {
    state: { ...state, confirmed, pending, lastSeq },
    gap: confirmed.some((entry) => entry.seq > lastSeq),
    added,
  };
}

/** The answer to `GET …/messages?after=<lastSeq>`: complete up to its highest `seq`. */
export function applyCatchUp(state: ThreadState, messages: readonly WidgetMessage[]): ApplyResult {
  const { confirmed, pending, added } = merge(state, messages);
  const lastSeq = Math.max(state.lastSeq, ...messages.map((message) => message.seq));

  return { state: { ...state, confirmed, pending, lastSeq }, gap: false, added };
}

export function addPending(state: ThreadState, entry: PendingMessage): ThreadState {
  if (state.pending.some((existing) => existing.client_id === entry.client_id)) {
    return state;
  }
  return { ...state, pending: [...state.pending, entry] };
}

export function setPendingStatus(
  state: ThreadState,
  clientId: string,
  status: PendingStatus,
): ThreadState {
  return {
    ...state,
    pending: state.pending.map((entry) =>
      entry.client_id === clientId ? { ...entry, status } : entry,
    ),
  };
}

export function applyReadReceipt(state: ThreadState, seq: number): ThreadState {
  return seq > state.readSeq ? { ...state, readSeq: seq } : state;
}

export type Delivery = PendingStatus | 'sent' | 'seen';

/** What the caption under a visitor's own message says (the `WidgetStatesEN` board, column 2). */
export function deliveryOf(state: ThreadState, message: WidgetMessage): Delivery {
  return message.seq <= state.readSeq ? 'seen' : 'sent';
}
