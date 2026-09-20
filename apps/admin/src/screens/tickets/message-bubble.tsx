import { tokens as designTokens } from '@helpdock/ui';
import { Box, Button, Typography } from '@mui/material';
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * DESIGN §6.3 MessageBubble: four kinds, each with its own anatomy, plus the
 * centred system event between two hairlines.
 *
 * **The body is rendered as HTML, deliberately.** `body_html` is sanitised on
 * the way in and stored sanitised ([ADR 0007](../../../../docs/decisions/0007-html-sanitizer.md)),
 * so what comes back is what the sanitiser produced: no script, no relative
 * URL, every link with `rel="noopener noreferrer nofollow"`. `body_text` is the
 * same message with the entities decoded and must never be put in HTML, which
 * is why it is not what is drawn here.
 */

export type BubbleKind = 'contact' | 'staff' | 'note' | 'ai';

export const MESSAGE_MAX_WIDTH = 720;

export function MessageBubble({
  kind,
  author,
  meta,
  bodyHtml,
  footer,
}: {
  readonly kind: BubbleKind;
  readonly author: string;
  /** The caption after the name: address, channel and time. */
  readonly meta: ReactNode;
  readonly bodyHtml: string;
  /** The sending / not-sent row under an optimistic bubble. */
  readonly footer?: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const teal = designTokens.palette.teal;

  const skin: Record<BubbleKind, { background: string; border: string; align: string }> = {
    contact: {
      background: tokens['bg.surface'],
      border: `1px solid ${tokens['border.default']}`,
      align: 'flex-start',
    },
    staff: {
      background: tokens['action.primary.tint'],
      border: `1px solid ${teal.teal100}`,
      align: 'flex-end',
    },
    ai: {
      background: tokens['bg.surface'],
      border: `1px solid ${teal.teal200}`,
      align: 'flex-start',
    },
    note: {
      background: tokens['status.warning.tint'],
      border: `1px dashed ${tokens['status.warning']}`,
      align: 'stretch',
    },
  };

  const { background, border, align } = skin[kind];

  return (
    <Box
      component="article"
      sx={{
        alignSelf: align,
        // A note is the width of the thread; it is not addressed to anybody.
        maxWidth: kind === 'note' ? '100%' : '85%',
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          backgroundColor: background,
          border,
          borderRadius: '10px',
          padding: 4,
        }}
      >
        {kind === 'note' ? (
          <Typography
            variant="caption"
            component="p"
            sx={{ color: tokens['status.warning.text'], fontWeight: 600, marginBlockEnd: 2 }}
          >
            {t('tickets:thread.note')}
          </Typography>
        ) : null}

        {kind === 'ai' ? (
          <Typography
            variant="caption"
            component="p"
            sx={{
              color: teal.teal700,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              marginBlockEnd: 2,
            }}
          >
            <Sparkles size={14} aria-hidden="true" />
            {t('tickets:thread.ai')}
          </Typography>
        ) : null}

        <Typography variant="bodyStrong" component="p">
          {author}
        </Typography>
        <Typography
          variant="caption"
          component="p"
          sx={{ color: 'text.secondary', marginBlockEnd: 3 }}
        >
          {meta}
        </Typography>

        <Box
          sx={{
            fontSize: 14,
            lineHeight: '22px',
            wordBreak: 'break-word',
            '& p': { margin: 0, marginBlockEnd: 2 },
            '& p:last-child': { marginBlockEnd: 0 },
            '& a': { color: tokens['text.link'] },
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: `body_html` is sanitised by the api before it is stored (ADR 0007); see the note at the top of this file.
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      </Box>
      {footer}
    </Box>
  );
}

/**
 * What the composer draws under a bubble it has not heard back about. A `seq`
 * is what makes a message sent (DOMAIN-RULES §7); until one arrives this says
 * so, and after ten seconds it offers the send again.
 */
export function PendingFooter({
  state,
  onRetry,
  onDiscard,
}: {
  readonly state: 'sending' | 'failed';
  onRetry(): void;
  onDiscard(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (state === 'sending') {
    return (
      <Typography
        variant="caption"
        component="p"
        role="status"
        sx={{ color: 'text.secondary', marginBlockStart: 1, textAlign: 'end' }}
      >
        {t('tickets:thread.sending')}
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 2,
        marginBlockStart: 1,
      }}
    >
      <Typography variant="caption" role="status" sx={{ color: tokens['status.danger.text'] }}>
        {t('tickets:thread.notSent')}
      </Typography>
      <Button size="small" variant="text" onClick={onRetry}>
        {t('tickets:thread.retry')}
      </Button>
      <Button size="small" variant="text" onClick={onDiscard}>
        {t('tickets:thread.discard')}
      </Button>
    </Box>
  );
}

/** DESIGN §6.3: a centred caption between two 24 px hairlines. */
export function SystemEvent({ children }: { readonly children: ReactNode }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        alignSelf: 'center',
        maxWidth: '100%',
        // The hairlines are the same on both sides, so nothing mirrors; the
        // text between them is what carries the direction.
        '&::before, &::after': {
          content: '""',
          width: 24,
          height: '1px',
          backgroundColor: tokens['border.default'],
          flexShrink: 0,
        },
      }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center' }}>
        {children}
      </Typography>
    </Box>
  );
}
