import type { CustomFieldDef, Ticket } from '@helpdock/schemas';
import { Box, Checkbox, Typography } from '@mui/material';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { TicketAiMark } from './ai/ticket-ai-mark.tsx';
import { ChannelMark, PriorityDot, SlaTimer, StatusBadge } from './badges.tsx';
import { elapsed, ticketReference, wakeTime } from './format.js';
import { PinnedFieldChip, pinnedValueOf } from './pinned-field-chip.tsx';

/** WhatsApp, Messenger and Instagram rows say which platform they are with an icon (M10-08). */
const isMetaChannel = (channel: Ticket['channel']): boolean =>
  channel === 'whatsapp' || channel === 'messenger' || channel === 'instagram';

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
 *
 * The contact's name is the one the list response embeds (M1-15). A row
 * without it — a ticket that names nobody, or a caller the api does not give
 * contact names to — prints the reference alone rather than an id.
 *
 * After them the caption says what the assistant did on the conversation:
 * "AI paused" or "AI answered" (M7-06), from the ticket's `ai` state.
 *
 * The link is named by its content, not by an `aria-label`: a label would
 * replace the priority, status, SLA and contact with the subject alone, which
 * is all a screen reader used to hear of a row.
 *
 * **The checkbox (M14-04) is the row's, not the link's**: a control inside an
 * anchor is two interactive elements in one, so the row is a flex `li` holding
 * the checkbox and then the link. A ticked row is tinted; the open one also
 * carries the 3 px edge, so "open" and "ticked" stay two different things.
 * Without `selection` (a Viewer) there is no checkbox and the row is as before.
 */
export interface RowSelection {
  readonly checked: boolean;
  /** `range` is true for a Shift-click: the rows between the last one ticked and this. */
  onSelect(range: boolean): void;
}

export function TicketRow({
  ticket,
  selected,
  now,
  search,
  selection,
  pinnedField,
}: {
  readonly ticket: Ticket;
  readonly selected: boolean;
  readonly now: number;
  /** Carried onto the link so the list a person came back to is the same list. */
  readonly search: string;
  /** M14-04: the checkbox, for somebody who may change tickets. */
  readonly selection?: RowSelection | undefined;
  /** M14-16: the brand's pinned field, whose value this row shows as a chip. */
  readonly pinnedField?: CustomFieldDef | undefined;
}): ReactNode {
  const tokens = useSemanticTokens();
  const t = useT();
  const { locale } = usePreferences();
  const reference = ticketReference(ticket);
  const contactName = ticket.contact?.name ?? null;
  const pinnedValue = pinnedValueOf(ticket, pinnedField);

  const ticked = selection?.checked === true;
  const tinted = selected || ticked;

  return (
    <Box
      component="li"
      data-ticket-id={ticket.id}
      sx={{
        listStyle: 'none',
        display: 'flex',
        alignItems: 'center',
        height: 64,
        borderBlockEnd: `1px solid ${tokens['border.default']}`,
        // DESIGN §6.3: the selected row is tinted and carries a 3 px edge at
        // the inline start, which is the right edge in Arabic.
        borderInlineStart: `3px solid ${selected ? tokens['action.primary'] : 'transparent'}`,
        backgroundColor: tinted ? tokens['action.primary.tint'] : 'transparent',
        '&:hover': {
          backgroundColor: tinted ? tokens['action.primary.tint'] : tokens['bg.muted'],
        },
      }}
    >
      {selection === undefined ? null : (
        <Checkbox
          size="small"
          checked={selection.checked}
          // The click, not the change, because only the click knows about Shift.
          onClick={(event) => {
            selection.onSelect(event.shiftKey);
          }}
          onChange={() => {}}
          slotProps={{
            input: {
              'aria-label': t('tickets:bulk.selectRow', { reference }),
            },
          }}
          sx={{ padding: 1, marginInlineStart: 2, flexShrink: 0 }}
        />
      )}
      <Box
        component={Link}
        to={{ pathname: ticketRoute(ticket.id), search }}
        aria-current={selected ? 'true' : undefined}
        sx={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          paddingInline: selection === undefined ? 4 : 2,
          paddingInlineEnd: 4,
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <PriorityDot priority={ticket.priority} />

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap dir="auto" sx={{ fontWeight: 500 }}>
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
            {isMetaChannel(ticket.channel) ? <ChannelMark channel={ticket.channel} /> : null}
            {contactName === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <Box component="bdi" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {contactName}
                </Box>
              </>
            )}
            <TicketAiMark state={ticket.ai} />
            {pinnedField === undefined || pinnedValue === null ? null : (
              <PinnedFieldChip def={pinnedField} value={pinnedValue} size="row" />
            )}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
          <StatusBadge status={ticket.status} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {ticket.snoozedUntil == null ? (
              <SlaTimer ticket={ticket} now={now} compact />
            ) : (
              <Box
                component="span"
                aria-label={t('tickets:snooze.rowLabel', {
                  time: wakeTime(ticket.snoozedUntil, locale, now),
                })}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 1,
                  color: 'text.primary',
                  fontSize: 12,
                }}
              >
                <Clock size={12} aria-hidden="true" />
                <bdi>{wakeTime(ticket.snoozedUntil, locale, now)}</bdi>
              </Box>
            )}
            <Typography variant="mono" sx={{ color: 'text.secondary', fontSize: 12 }}>
              {elapsed(ticket.updatedAt, now)}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
