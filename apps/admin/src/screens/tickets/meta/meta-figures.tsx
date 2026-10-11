import { Box, Typography } from '@mui/material';
import { CircleDashed, Image as ImageIcon, Reply } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The small pieces a Meta customer's message is drawn with beyond text
 * (DESIGN §6.3 MessageBubble, Meta content; M10-08, `Admin/Ticket-Meta`
 * columns 2 and 3): a quoted earlier message, a sticker, and a story reply.
 * Photos and files are the Telegram figures and AttachmentChips, as they are on
 * every channel.
 */

/** "Lina Haddad: Could you send a photo of the label?", the earlier message a reply answers. */
export function QuoteLine({
  author,
  text,
}: {
  /** Who wrote it, when the thread still has the message; null draws the words alone. */
  readonly author: string | null;
  readonly text: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="blockquote"
      aria-label={t('tickets:meta.quote.label')}
      sx={{
        margin: 0,
        marginBlockEnd: 2,
        paddingInlineStart: 2,
        borderInlineStart: `2px solid ${tokens['border.strong']}`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        fontSize: 12,
        lineHeight: '16px',
        color: 'text.secondary',
      }}
    >
      <Box
        component="span"
        aria-hidden="true"
        // The arrow points back at what is being answered, so it follows the reading direction.
        sx={{ display: 'inline-flex', flexShrink: 0, '[dir="rtl"] &': { transform: 'scaleX(-1)' } }}
      >
        <Reply size={14} />
      </Box>
      <bdi dir="auto">
        {author === null ? text : t('tickets:meta.quote.from', { author, text })}
      </bdi>
    </Box>
  );
}

/** A sticker is an image: a 96 px figure on `bg.muted`. */
export function StickerFigure(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="img"
      aria-label={t('tickets:meta.sticker')}
      sx={{
        width: 96,
        height: 96,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: 'text.secondary',
      }}
    >
      <ImageIcon size={24} aria-hidden="true" />
      <Typography variant="caption">{t('tickets:meta.sticker')}</Typography>
    </Box>
  );
}

/** The caption over a story reply or mention: a 12 px `CircleDashed` and the words the inbound service wrote. */
export function StoryCaption({ label }: { readonly label: string }): ReactNode {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        marginBlockEnd: 2,
        color: 'text.secondary',
      }}
    >
      <CircleDashed size={14} aria-hidden="true" />
      {label}
    </Typography>
  );
}

/**
 * The story a customer replied to: a 132 × 120 figure, "Story · 10 Oct · kept
 * until it expires". The media is the story's own, which the platform removes
 * after 24 hours, so what the thread keeps is this stand-in and the file the
 * fetch job saved while the link lasted.
 */
export function StoryFigure({ date }: { readonly date: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="img"
      aria-label={t('tickets:meta.story.figure', { date })}
      sx={{
        width: 132,
        height: 120,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        padding: 2,
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: 'text.secondary',
        textAlign: 'center',
      }}
    >
      <ImageIcon size={24} aria-hidden="true" />
      <Typography variant="caption" aria-hidden="true">
        {t('tickets:meta.story.figure', { date })}
      </Typography>
    </Box>
  );
}
