import { tokens as designTokens } from '@helpdock/ui';
import { Box, Button, Typography } from '@mui/material';
import { Sparkles } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 AISuggestionCard (M7-05): what assist proposes before the agent
 * takes it — a header with `Sparkles`, the title, a caption, a ghost discard
 * and an outlined accept at the inline end, then the text in its own language
 * and whatever follows it (citations, tone chips, the AI log). Nothing reaches
 * the composer until the accept button is pressed.
 */
export function AISuggestionCard({
  title,
  caption,
  lang,
  text,
  acceptLabel,
  discardLabel,
  onAccept,
  onDiscard,
  before,
  children,
}: {
  readonly title: string;
  readonly caption?: string | undefined;
  /** The text's language, for `lang` and `dir`. */
  readonly lang: 'en' | 'ar';
  readonly text: string;
  readonly acceptLabel: string;
  readonly discardLabel: string;
  onAccept(): void;
  onDiscard(): void;
  /** Between the header and the text: the tone chips of "Rewritten". */
  readonly before?: ReactNode;
  /** Under the text: citations and the AI log. */
  readonly children?: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const headingId = useId();

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 3,
        borderRadius: '6px',
        backgroundColor: tokens['action.primary.tint'],
        border: `1px solid ${designTokens.palette.teal.teal100}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Sparkles size={14} aria-hidden="true" color={tokens['action.primary']} />
        <Typography id={headingId} component="h3" sx={{ fontSize: 13, fontWeight: 600 }}>
          {title}
        </Typography>
        {caption === undefined ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {caption}
          </Typography>
        )}
        <Box sx={{ display: 'flex', gap: 2, marginInlineStart: 'auto' }}>
          <Button size="small" variant="text" onClick={onDiscard}>
            {discardLabel}
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={onAccept}
            sx={{ backgroundColor: tokens['bg.surface'] }}
          >
            {acceptLabel}
          </Button>
        </Box>
      </Box>
      {before}
      <Typography
        component="p"
        lang={lang}
        dir={lang === 'ar' ? 'rtl' : 'ltr'}
        sx={{ fontSize: 14, lineHeight: '22px', whiteSpace: 'pre-wrap', margin: 0 }}
      >
        {text}
      </Typography>
      {children}
    </Box>
  );
}
