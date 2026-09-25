import type { Ticket } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { PriorityDot, SlaTimer, StatusBadge } from './badges.tsx';
import { elapsed, ticketReference } from './format.js';

/**
 * DESIGN §6.3 TicketRow, in its 64 px side-list form: the priority dot, the
 * subject, one caption line and the time at the end.
 *
 * It is a link, not a row with a click handler. The whole workspace is
 * addressable — `/tickets/:ticketId` is the ticket — so a row has to be
 * something a person can open in a new tab, and `j`/`k` navigate rather than
 * select a row that only this screen knows about.
 *
 * The caption is `<bdi>`-wrapped around the reference and the contact, because
 * `HD-1042` and an email address are Latin runs inside an Arabic line and
 * without it the punctuation between them jumps to the wrong end (DESIGN §7).
 */
export function TicketRow({
  ticket,
  contactName,
  selected,
  now,
  search,
}: {
  readonly ticket: Ticket;
  readonly contactName: string | null;
  readonly selected: boolean;
  readonly now: number;
  /** Carried onto the link so the list a person came back to is the same list. */
  readonly search: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const reference = ticketReference(ticket);

  return (
    <Box component="li" sx={{ listStyle: 'none' }}>
      <Box
        component={Link}
        to={{ pathname: ticketRoute(ticket.id), search }}
        aria-current={selected ? 'true' : undefined}
        aria-label={t('tickets:list.rowLabel', { reference, subject: ticket.subject })}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          height: 64,
          paddingInline: 4,
          textDecoration: 'none',
          color: 'inherit',
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
          // DESIGN §6.3: the selected row is tinted and carries a 3 px edge at
          // the inline start, which is the right edge in Arabic.
          borderInlineStart: `3px solid ${selected ? tokens['action.primary'] : 'transparent'}`,
          backgroundColor: selected ? tokens['action.primary.tint'] : 'transparent',
          '&:hover': {
            backgroundColor: selected ? tokens['action.primary.tint'] : tokens['bg.muted'],
          },
        }}
      >
        <PriorityDot priority={ticket.priority} />

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
            {ticket.subject}
          </Typography>
          <Typography
            variant="caption"
            noWrap
            component="p"
            sx={{ color: 'text.secondary', display: 'flex', gap: 1, alignItems: 'center' }}
          >
            <Typography component="bdi" variant="mono" sx={{ fontSize: 12 }}>
              {reference}
            </Typography>
            {contactName === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <Box component="bdi" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {contactName}
                </Box>
              </>
            )}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
          <StatusBadge status={ticket.status} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <SlaTimer ticket={ticket} now={now} compact />
            <Typography variant="mono" sx={{ color: 'text.secondary', fontSize: 12 }}>
              {elapsed(ticket.updatedAt, now)}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
