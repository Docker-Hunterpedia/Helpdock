import type { Ticket } from '@helpdock/schemas';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material';
import { Eye, PanelRightOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { ChannelLabel, PriorityBadge, SlaTimer, StatusBadge } from './badges.tsx';
import { ticketReference } from './format.js';
import { TicketActionsMenu, type TicketHeaderAction } from './ticket-actions-menu.tsx';

/**
 * The header of the ticket column: the mono reference and the subject, then
 * one row carrying every badge, then the collision pill when somebody else has
 * the same ticket open.
 *
 * Tags are drawn only when the ticket has any. `tags` is M1-06's and the api
 * refuses the filter until then, so an empty chip row would be a promise this
 * screen cannot keep.
 */
export function TicketHeader({
  ticket,
  departmentName,
  viewers,
  now,
  showDetailsButton,
  onShowDetails,
  actions = [],
}: {
  readonly ticket: Ticket;
  readonly departmentName: string | undefined;
  /** The names of the other people in `ticket:<id>` right now. */
  readonly viewers: readonly string[];
  readonly now: number;
  readonly showDetailsButton: boolean;
  onShowDetails(): void;
  /** The ⋯ menu's items, which each deliverable contributes (`ticket-actions-menu.tsx`). */
  readonly actions?: readonly TicketHeaderAction[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [first, ...rest] = viewers;

  return (
    <Box
      // A `<header>` inside `<main>` is not the page's banner, so it is a
      // named region instead: the badge row is a thing a person navigates to.
      component="section"
      aria-label={t('tickets:header.label')}
      sx={{
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        backgroundColor: tokens['bg.surface'],
        borderBlockEnd: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="mono" component="p" sx={{ color: 'text.secondary', fontSize: 12 }}>
            <bdi>{ticketReference(ticket)}</bdi>
          </Typography>
          <Typography variant="h2" component="h1" sx={{ fontSize: 18 }}>
            {ticket.subject}
          </Typography>
        </Box>

        <Tooltip title={t('tickets:header.macroUnavailable')}>
          <Box component="span" sx={{ display: 'inline-flex' }}>
            <Button variant="outlined" size="small" disabled>
              {t('tickets:header.macro')}
            </Button>
          </Box>
        </Tooltip>

        <TicketActionsMenu actions={actions} />

        {showDetailsButton ? (
          <IconButton size="small" aria-label={t('tickets:header.details')} onClick={onShowDetails}>
            <PanelRightOpen size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <StatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        <SlaTimer ticket={ticket} now={now} />
        <ChannelLabel channel={ticket.channel} departmentName={departmentName} />
      </Box>

      {first === undefined ? null : (
        <Typography
          role="status"
          variant="caption"
          sx={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            height: 22,
            paddingInline: 2,
            borderRadius: '999px',
            backgroundColor: tokens['status.warning.tint'],
            color: tokens['status.warning.text'],
          }}
        >
          <Eye size={12} aria-hidden="true" />
          {rest.length === 0
            ? t('tickets:header.viewingOne', { name: first })
            : t('tickets:header.viewingMany', { name: first, others: rest.length })}
        </Typography>
      )}
    </Box>
  );
}
