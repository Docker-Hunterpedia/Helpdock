import type { AiCallView, TicketMessage, TicketMessageAi } from '@helpdock/schemas';
import { tokens as designTokens } from '@helpdock/ui';
import { Box, Link, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AIBadge } from './ai-badge.tsx';
import { AILogDisclosure } from './ai-log-disclosure.tsx';
import { CitationList } from './citation-list.tsx';

/**
 * An auto-reply in the staff thread (M7-06, `Admin/Ticket-AI`, DESIGN §6.6
 * "AI answer" as the admin draws it): above the bubble "AI · Assistant ·
 * auto-reply · 09:12", the answer with each `[n]` linked to its source, the
 * CitationList with every source's visibility, and the AILogDisclosure. The
 * handoff message is the same bubble with the brand's text and its log.
 */

const MARKER = /\[(\d+)\]/g;

function CitedText({
  text,
  citations,
  idPrefix,
}: {
  readonly text: string;
  readonly citations: TicketMessageAi['citations'];
  readonly idPrefix: string;
}): ReactNode {
  const t = useT();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const marker = Number(match[1]);
    const citation = citations.find((entry) => entry.marker === marker);
    parts.push(text.slice(last, match.index));
    parts.push(
      citation === undefined ? (
        match[0]
      ) : (
        <Link
          key={`${match.index}`}
          href={`#${idPrefix}-source-${marker}`}
          aria-label={t('tickets:autoReply.source', { n: marker, title: citation.title })}
          sx={{ fontFamily: 'inherit' }}
        >
          <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
            {match[0]}
          </Typography>
        </Link>
      ),
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function AutoReplyMessage({
  message,
  ai,
  call,
  time,
}: {
  readonly message: TicketMessage;
  readonly ai: TicketMessageAi;
  readonly call: AiCallView | undefined;
  /** The message's time, already formatted for the reader. */
  readonly time: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const idPrefix = `ai-${message.id}`;
  const meta = t(
    ai.kind === 'handoff' ? 'tickets:autoReply.handoffMeta' : 'tickets:autoReply.answerMeta',
  );

  return (
    <Box component="article" sx={{ alignSelf: 'flex-start', maxWidth: '85%', minWidth: 0 }}>
      <Typography
        variant="caption"
        component="p"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          marginBlockEnd: 1,
          color: 'text.secondary',
        }}
      >
        <AIBadge />
        <span>
          {t('tickets:autoReply.author')} · {meta} · <bdi>{time}</bdi>
        </span>
      </Typography>
      <Box
        sx={{
          backgroundColor: tokens['bg.surface'],
          border: `1px solid ${designTokens.palette.teal.teal200}`,
          borderRadius: '10px',
          padding: 4,
          fontSize: 14,
          lineHeight: '22px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        <Box component="p" sx={{ margin: 0 }}>
          <CitedText
            text={ai.answer ?? message.bodyText}
            citations={ai.citations}
            idPrefix={idPrefix}
          />
        </Box>
        {ai.citations.length === 0 ? null : (
          <CitationList citations={ai.citations} idPrefix={idPrefix} />
        )}
        <AILogDisclosure ai={ai} call={call} />
      </Box>
    </Box>
  );
}
