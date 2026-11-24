import { Box, Button, IconButton, Typography } from '@mui/material';
import { Reply, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * DESIGN §6.3 ReplyToStrip (M14-31, `Admin/Ticket-ListToggle-ReplyTo`): the line
 * above the composer's text that says which customer email the reply answers.
 * "Show quote" opens that email's text read-only; the server adds the quote
 * when the mail is sent, so what is shown here is never part of the draft.
 */

export interface ComposerReplyTo {
  /** Who wrote the email; the strip reads "Replying to {name}’s email of {time}". */
  readonly name: string;
  readonly time: string;
  /** The email's plain text, for "Show quote". */
  readonly quote: string;
  /** The api refused the target: "That message is no longer available". */
  readonly unavailable: boolean;
  onClear(): void;
}

export function ReplyToStrip({ replyTo }: { readonly replyTo: ComposerReplyTo }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const quoteId = useId();
  const [open, setOpen] = useState(false);

  return (
    <Box
      role="group"
      aria-label={t('tickets:replyTo.stripLabel')}
      sx={{
        padding: 2,
        paddingInlineStart: '10px',
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        color: tokens['text.primary'],
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Reply
          size={14}
          aria-hidden="true"
          style={{ flexShrink: 0, transform: locale === 'ar' ? 'scaleX(-1)' : undefined }}
        />
        <Typography
          variant="caption"
          dir="auto"
          sx={{
            flexGrow: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t('tickets:replyTo.strip', { name: replyTo.name, time: replyTo.time })}
        </Typography>
        <Button
          size="small"
          variant="text"
          aria-expanded={open}
          aria-controls={quoteId}
          onClick={() => {
            setOpen((held) => !held);
          }}
          sx={{ height: 24, paddingInline: 1.5, minWidth: 0, fontSize: 12, flexShrink: 0 }}
        >
          {open ? t('tickets:replyTo.hideQuote') : t('tickets:replyTo.showQuote')}
        </Button>
        <IconButton
          size="small"
          aria-label={t('tickets:replyTo.clear')}
          onClick={replyTo.onClear}
          sx={{ width: 24, height: 24, flexShrink: 0 }}
        >
          <X size={14} aria-hidden="true" />
        </IconButton>
      </Box>
      <Box
        id={quoteId}
        hidden={!open}
        aria-label={t('tickets:replyTo.quoteLabel')}
        role="group"
        dir="auto"
        sx={{
          display: open ? 'block' : 'none',
          paddingInlineStart: 3,
          borderInlineStart: `2px solid ${tokens['border.strong']}`,
          color: tokens['text.secondary'],
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 160,
          overflowY: 'auto',
        }}
      >
        {replyTo.quote}
      </Box>
      {replyTo.unavailable ? (
        <Typography
          variant="caption"
          role="alert"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            color: tokens['status.danger.text'],
          }}
        >
          <TriangleAlert size={14} aria-hidden="true" />
          {t('tickets:replyTo.unavailable')}
        </Typography>
      ) : null}
    </Box>
  );
}
