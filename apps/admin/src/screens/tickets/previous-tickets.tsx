import type { ContactTimelineItem, TicketStatus } from '@helpdock/schemas';
import { Box, Link as MuiLink, Skeleton, Typography } from '@mui/material';
import { Lock } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { contactRoute, ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { StatusBadge } from './badges.tsx';
import {
  type PreviousTickets as History,
  PREVIOUS_TICKETS_SHOWN,
  previousTicketDate,
} from './contact-history.js';
import { isolate } from './format.js';

/** The contact timeline as the section reads it: still loading, unreadable, or read. */
export type ContactHistoryState = 'loading' | 'failed' | History;

/** DESIGN §6.3: a skeleton's count matches the rows it stands in for. */
const SKELETON_ROWS = Array.from({ length: PREVIOUS_TICKETS_SHOWN }, (_, row) => `row-${row}`);

/**
 * The contact card's Previous tickets (M1-04 follow-up, `Admin/Ticket-ContactHistory`):
 * a returning customer is visible without leaving the ticket.
 *
 * The rows come from the contact timeline, which is department-scoped
 * (DOMAIN-RULES §1.2), so it lists only what this reader may open and says how
 * many it hid. A timeline that could not be read draws nothing rather than
 * "This is their first ticket.", which would be a claim the panel cannot make.
 */
export function PreviousTickets({
  contact,
  history,
  statuses,
  now,
}: {
  readonly contact: { readonly id: string; readonly name: string };
  readonly history: ContactHistoryState;
  /** The brand's statuses, which the badges are drawn from. */
  readonly statuses: readonly TicketStatus[];
  readonly now: number;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();

  if (history === 'failed') {
    return null;
  }

  const count = history === 'loading' ? 0 : history.count;

  const hiddenLine =
    history !== 'loading' && history.hiddenCount > 0 ? (
      <Typography
        variant="caption"
        component="p"
        sx={{
          color: tokens['status.warning.text'],
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Lock size={12} aria-hidden="true" />
        {t('tickets:details.hiddenTickets', { count: history.hiddenCount })}
      </Typography>
    ) : null;

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2, marginBlockStart: 4 }}
    >
      <Typography id={headingId} variant="caption" component="h3" sx={{ color: 'text.secondary' }}>
        {t('tickets:details.previous')}
        {count > 0 ? (
          <Typography
            component="span"
            variant="mono"
            sx={{ fontSize: 'inherit', lineHeight: 'inherit' }}
          >
            {` · ${count}`}
          </Typography>
        ) : null}
      </Typography>

      {history === 'loading' ? (
        <Box aria-hidden="true" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} variant="rounded" height={44} />
          ))}
        </Box>
      ) : history.shown.length === 0 ? (
        (hiddenLine ?? (
          <Typography variant="body2" sx={{ fontSize: 13, color: 'text.secondary' }}>
            {t('tickets:details.firstTicket')}
          </Typography>
        ))
      ) : (
        <>
          <Box
            component="ul"
            sx={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {history.shown.map((item) => (
              <PreviousTicketRow
                key={item.id}
                item={item}
                status={statuses.find((candidate) => candidate.id === item.statusId)}
                now={now}
              />
            ))}
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {hiddenLine}
            <MuiLink component={Link} to={contactRoute(contact.id)} variant="caption">
              {t('tickets:details.viewAllOn', { name: isolate(contact.name) })}
            </MuiLink>
          </Box>
        </>
      )}
    </Box>
  );
}

/** One previous ticket: a single link of at least 44 px, its badge at the inline end. */
function PreviousTicketRow({
  item,
  status,
  now,
}: {
  readonly item: ContactTimelineItem;
  /** Undefined until the brand's statuses are read, when the row goes without its badge. */
  readonly status: TicketStatus | undefined;
  readonly now: number;
}): ReactNode {
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();

  return (
    <Box component="li">
      <MuiLink
        component={Link}
        to={ticketRoute(item.id)}
        underline="none"
        sx={{
          minHeight: 44,
          paddingBlock: 1,
          paddingInline: 2,
          marginInline: -2,
          borderRadius: '6px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          color: 'text.primary',
          '&:hover': { backgroundColor: tokens['bg.muted'] },
        }}
      >
        <Box
          component="span"
          sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        >
          <Box
            component="span"
            dir="auto"
            sx={{
              fontSize: 13,
              lineHeight: '20px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.subject}
          </Box>
          <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
            <Typography
              component="bdi"
              variant="mono"
              sx={{ fontSize: 'inherit', lineHeight: 'inherit' }}
            >
              {item.reference}
            </Typography>
            {` · ${previousTicketDate(item.createdAt, locale, now)}`}
          </Typography>
        </Box>
        {status === undefined ? null : (
          <Box component="span" sx={{ flexShrink: 0 }}>
            <StatusBadge status={status} />
          </Box>
        )}
      </MuiLink>
    </Box>
  );
}
