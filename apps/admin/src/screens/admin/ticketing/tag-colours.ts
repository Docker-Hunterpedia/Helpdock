import type { TagColor } from '@helpdock/schemas';
import type { SemanticTokens } from '@helpdock/ui';

/**
 * DESIGN §6.2: a tag is drawn in one of eight tints — the four status tints a
 * tag may borrow, and four steps of the warm neutral ramp. Never the danger
 * tint: red means "breached" or "destructive" on this desk.
 *
 * Every value is a semantic token, so a brand's `surfaceTone` moves the four
 * neutrals with the rest of the app and dark mode needs no second table. The
 * neutral steps are read off the border tokens because those *are* n200 and
 * n300 in DESIGN §2.2 — the same two values, which is what keeps this inside
 * the palette instead of introducing four more.
 */

export interface TagTint {
  readonly background: string;
  readonly border: string;
  readonly text: string;
}

export const TAG_COLOURS: readonly TagColor[] = [
  'info',
  'success',
  'warning',
  'escalated',
  'sand',
  'stone',
  'clay',
  'bark',
];

export const tagTint = (colour: TagColor, tokens: SemanticTokens): TagTint => {
  switch (colour) {
    case 'info':
    case 'success':
    case 'warning':
    case 'escalated':
      return {
        background: tokens[`status.${colour}.tint`],
        border: tokens[`status.${colour}`],
        text: tokens[`status.${colour}.text`],
      };
    case 'sand':
      return {
        background: tokens['bg.canvas'],
        border: tokens['border.default'],
        text: tokens['text.primary'],
      };
    case 'stone':
      return {
        background: tokens['bg.muted'],
        border: tokens['border.strong'],
        text: tokens['text.primary'],
      };
    case 'clay':
      return {
        background: tokens['border.default'],
        border: tokens['border.strong'],
        text: tokens['text.primary'],
      };
    case 'bark':
      return {
        background: tokens['border.strong'],
        border: tokens['text.secondary'],
        text: tokens['text.primary'],
      };
  }
};
