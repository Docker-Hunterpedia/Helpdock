import type { ContactTimelineItem, TicketStatus } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { StatusBadge } from '../tickets/badges.tsx';
import { knownChannel } from './format.js';

/**
 * One ticket on the contact's timeline: the subject in its own direction, then
 * the reference, the channel, the department and who has it, each in words.
 * The status is the brand's StatusBadge, so it reads in the reader's language;
 * until the brand's statuses are read the row prints the name the timeline
 * sent.
 */
export function TimelineTicket({
  item,
  status,
}: {
  readonly item: ContactTimelineItem;
  readonly status: TicketStatus | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const channel = knownChannel(item.channel);
  const facts = [
    { key: 'channel', text: channel === null ? item.channel : t(`tickets:channel.${channel}`) },
    { key: 'department', text: item.departmentName },
    { key: 'assignee', text: item.assigneeName ?? t('tickets:list.unassigned') },
  ].filter((fact): fact is { key: string; text: string } => fact.text !== null);

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 3,
        border: `1px solid ${tokens['border.default']}`,
        borderRadius: '10px',
        padding: 4,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="bodyStrong" component="p" dir="auto">
          {item.subject}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          <bdi>{item.reference}</bdi>
          {facts.map((fact) => (
            <span key={fact.key}>
              {' · '}
              <bdi>{fact.text}</bdi>
            </span>
          ))}
        </Typography>
      </Box>
      {status === undefined ? (
        <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
          {item.status}
        </Typography>
      ) : (
        <Box sx={{ flexShrink: 0 }}>
          <StatusBadge status={status} />
        </Box>
      )}
    </Box>
  );
}
