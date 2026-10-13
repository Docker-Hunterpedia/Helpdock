import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../../../../app/tokens.js';

export type MetaNoteTone = 'neutral' | 'info' | 'success' | 'danger';

/**
 * The one box Channels › Meta draws a sentence in beside a form: a fact the
 * person should know before they continue (`neutral`, `info`) or what a test
 * found (`success`, `danger`). It is DESIGN §6.4's Banner at body size, 12 px
 * inside, an 8 px gap and a 16 px icon on the first line, so every note on these
 * screens has the same measure instead of its own.
 *
 * `role` is `note` for a standing fact and `status` or `alert` for an outcome
 * that has just appeared, which is what a screen reader should read out.
 */
export function MetaNote({
  tone = 'neutral',
  role = 'note',
  icon,
  children,
}: {
  readonly tone?: MetaNoteTone;
  readonly role?: 'note' | 'status' | 'alert';
  /** A 16 px Lucide icon, `aria-hidden`. */
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const palette =
    tone === 'neutral'
      ? {
          background: tokens['bg.canvas'],
          border: tokens['border.default'],
          text: tokens['text.secondary'],
        }
      : {
          background: tokens[`status.${tone}.tint`],
          border: tokens[`status.${tone}`],
          text: tokens[`status.${tone}.text`],
        };

  return (
    <Box
      role={role}
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        padding: 3,
        borderRadius: '6px',
        backgroundColor: palette.background,
        border: `1px solid ${palette.border}`,
        color: palette.text,
        '& strong': { color: tone === 'neutral' ? tokens['text.primary'] : 'inherit' },
      }}
    >
      {/* The icon is as tall as one line of body text, so it sits on the first. */}
      <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex', paddingBlockStart: 0.5 }}>
        {icon}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

/** A line of a {@link MetaNote}: body size in the note's colour; the first of two is {@link NoteTitle}. */
export function NoteText({
  children,
  dir,
}: {
  readonly children: ReactNode;
  readonly dir?: 'auto' | 'ltr' | 'rtl';
}): ReactNode {
  return (
    <Typography
      variant="body2"
      component="p"
      {...(dir === undefined ? {} : { dir })}
      sx={{ margin: 0, color: 'inherit', overflowWrap: 'anywhere' }}
    >
      {children}
    </Typography>
  );
}

/** What a note says first, in body-strong. */
export function NoteTitle({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <Typography variant="bodyStrong" component="p" sx={{ margin: 0, color: 'inherit' }}>
      {children}
    </Typography>
  );
}
