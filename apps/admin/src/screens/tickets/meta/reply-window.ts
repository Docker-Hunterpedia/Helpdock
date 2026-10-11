import type { ReplyWindowView } from '@helpdock/schemas';
import { isClosing } from './meta-format.js';

/**
 * What the ReplyWindowStrip says and whether Send may be pressed (M10-08).
 *
 * The api answers the window for a person writing at the moment it was asked
 * (`ReplyWindowView`); the strip reads it against the clock, so a window that
 * runs out while the ticket is open turns closed on the next minute's tick
 * without a request, and so a refusal at Send (`reply-window-closed`, the
 * race of the last minute) turns it closed at once, with the line that says the
 * text was kept.
 */

export type StripState =
  | { readonly kind: 'open' | 'closing' | 'humanAgent'; readonly closesAt: string }
  | {
      readonly kind: 'closed';
      /** When the window closed; null when the customer never wrote. */
      readonly closedAt: string | null;
      /** The api refused a reply while the strip still said open. */
      readonly refused: boolean;
    };

/** What a 409 `reply-window-closed` said: when the window closed. */
export interface WindowRefusal {
  readonly closedAt: string | null;
}

export const stripState = (
  window: ReplyWindowView,
  now: number,
  refusal: WindowRefusal | null,
): StripState => {
  if (refusal !== null) {
    return {
      kind: 'closed',
      closedAt: refusal.closedAt ?? (window.state === 'closed' ? window.closedAt : null),
      refused: true,
    };
  }
  if (window.state === 'closed') {
    return { kind: 'closed', closedAt: window.closedAt, refused: false };
  }
  if (Date.parse(window.closesAt) <= now) {
    return { kind: 'closed', closedAt: window.closesAt, refused: false };
  }
  if (window.state === 'human_agent') {
    return { kind: 'humanAgent', closesAt: window.closesAt };
  }

  return { kind: isClosing(window.closesAt, now) ? 'closing' : 'open', closesAt: window.closesAt };
};
