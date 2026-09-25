import type { Tag, TagColor } from '@helpdock/schemas';
import { Box } from '@mui/material';
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
 */
export function TagChip({
  tag,
}: {
  readonly tag: Pick<Tag, 'name' | 'nameAr'> & { readonly color: TagColor };
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
        blockSize: 22,
        paddingInline: 2,
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
    </Box>
  );
}
