import type { Tag, TagColor } from '@helpdock/schemas';
import { Box, ButtonBase } from '@mui/material';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { tagTint } from './tag-colours.js';

/**
 * DESIGN §6.2 Tag: 22 px, radius md, 12 px at weight 500, one of the eight
 * tints. Nothing is drawn from colour alone — the name is always there — so the
 * tint is decoration and the chip still works in greyscale (§10).
 *
 * The Arabic name wins while the desk is in Arabic and falls back to the Latin
 * one, as a department's name does on its own list.
 *
 * With `onRemove` the chip ends in a × that takes it off at once — the details
 * panel's tags row (`AdminTicketTags`, panel 1). The glyph is 12 px but the
 * button is the 28 px admin target of DESIGN §10, overhanging the 22 px chip
 * rather than growing it. `removeLabel` names the button, because "×" alone
 * does not say which chip it removes.
 */
export function TagChip({
  tag,
  removeLabel,
  onRemove,
}: {
  readonly tag: Pick<Tag, 'name' | 'nameAr'> & { readonly color: TagColor };
  readonly removeLabel?: string;
  onRemove?(): void;
}): ReactNode {
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const tint = tagTint(tag.color, tokens);
  const arabic = locale === 'ar' && tag.nameAr !== null;

  return (
    <Box
      component="span"
      lang={arabic ? 'ar' : undefined}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        blockSize: 22,
        paddingInlineStart: 2,
        paddingInlineEnd: onRemove === undefined ? 2 : 1,
        borderRadius: '6px',
        border: `1px solid ${tint.border}`,
        backgroundColor: tint.background,
        color: tint.text,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
      }}
    >
      {arabic ? tag.nameAr : tag.name}
      {onRemove === undefined ? null : (
        <ButtonBase
          aria-label={removeLabel}
          onClick={onRemove}
          sx={{
            inlineSize: 28,
            blockSize: 28,
            marginBlock: '-3px',
            marginInlineStart: '-6px',
            marginInlineEnd: '-8px',
            borderRadius: '4px',
            color: 'inherit',
            // The theme's focus ring (DESIGN §10), which it gives Button but not ButtonBase.
            '&:focus-visible': {
              outline: `2px solid ${tokens['border.focus']}`,
              outlineOffset: '2px',
            },
          }}
        >
          <X size={12} aria-hidden="true" />
        </ButtonBase>
      )}
    </Box>
  );
}
