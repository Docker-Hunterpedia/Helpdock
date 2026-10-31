import type { CustomFieldDef, Ticket, TicketViewingActivity } from '@helpdock/schemas';
import { importSourceLink } from '@helpdock/schemas';
import { Box, Chip, IconButton, Tooltip, Typography } from '@mui/material';
import { ExternalLink, Eye, PanelRightOpen, PenLine } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { ChannelLabel, PriorityBadge, SlaTimer, StatusBadge } from './badges.tsx';
import { ticketReference } from './format.js';
import { PinnedFieldChip, pinnedValueOf } from './pinned-field-chip.tsx';
import { type TicketAction, TicketActionsMenu } from './ticket-actions-menu.tsx';

/**
 * The header of the ticket column: the mono reference and the subject, then
 * one row carrying every badge, then the collision pill when somebody else has
 * the same ticket open — "is viewing", or "is replying" when their composer has
 * something in it (M1-09), which is the one worth stopping for.
 *
 * The subject is a one-line `h2` (M14-19). Macros are not here: they are the
 * composer's button and `/`, and "Apply a macro" in the command palette (UX-21).
 *
 * The ⋯ menu's entries are the caller's ({@link TicketActionsMenu}), so the
 * deliverables that add to it do not edit the header.
 *
 * Tags are drawn only when the ticket has any. `tags` is M1-06's and the api
 * refuses the filter until then, so an empty chip row would be a promise this
 * screen cannot keep.
 */
export interface HeaderViewer {
  readonly name: string;
  readonly activity: TicketViewingActivity;
}

export function TicketHeader({
  ticket,
  departmentName,
  channelHandle,
  channelAccount,
  viewers,
  actions,
  now,
  showDetailsButton,
  onShowDetails,
  snooze,
  pinnedField,
}: {
  readonly ticket: Ticket;
  readonly departmentName: string | undefined;
  /** The contact on the channel, as the chip names them: Telegram's username (M6-02). */
  readonly channelHandle?: string | undefined;
  /** M10-08: the brand's number, Page or `@handle` a Meta ticket is with: "WhatsApp · +1 555 0142 · Support". */
  readonly channelAccount?: string | undefined;
  /** The other people in `ticket:<id>` right now, whoever is replying first. */
  readonly viewers: readonly HeaderViewer[];
  /** The ⋯ menu's entries, in the artboard's order. */
  readonly actions: readonly TicketAction[];
  readonly now: number;
  readonly showDetailsButton: boolean;
  onShowDetails(): void;
  /** M14-02: the Snooze button and its menu. Absent when the ticket cannot be snoozed. */
  readonly snooze?: ReactNode;
  /** M14-16: the brand's pinned field, shown beside the priority when the ticket has a value. */
  readonly pinnedField?: CustomFieldDef | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [first, ...rest] = viewers;
  const importedUrl = importSourceLink(ticket.imported?.url);
  const pinnedValue = pinnedValueOf(ticket, pinnedField);

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
          {/* M14-19: one line, whatever the subject's length. The tooltip gives
              the heading its full text as its name and shows it on hover. */}
          <Tooltip title={ticket.subject} placement="bottom-start">
            <Typography
              variant="h2"
              component="h2"
              dir="auto"
              noWrap
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {ticket.subject}
            </Typography>
          </Tooltip>
        </Box>

        {snooze}

        <TicketActionsMenu items={actions} />

        {showDetailsButton ? (
          <IconButton size="small" aria-label={t('tickets:header.details')} onClick={onShowDetails}>
            <PanelRightOpen size={16} aria-hidden="true" className="mirror-in-rtl" />
          </IconButton>
        ) : null}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <StatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        {pinnedField === undefined || pinnedValue === null ? null : (
          <PinnedFieldChip def={pinnedField} value={pinnedValue} size="header" />
        )}
        {ticket.imported ? (
          <Chip
            size="small"
            variant="outlined"
            label={t(
              ticket.imported.number ? 'tickets:header.importedNumber' : 'tickets:header.imported',
              {
                source: t(`imports:sources.${ticket.imported.source}`),
                number: ticket.imported.number,
              },
            )}
            {...(importedUrl
              ? {
                  component: 'a' as const,
                  href: importedUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  clickable: true,
                  icon: <ExternalLink size={14} aria-hidden="true" />,
                }
              : {})}
          />
        ) : null}
        <SlaTimer ticket={ticket} now={now} />
        <ChannelLabel
          channel={ticket.channel}
          departmentName={departmentName}
          handle={channelHandle}
          account={channelAccount}
        />
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
          {first.activity === 'replying' ? (
            <PenLine size={12} aria-hidden="true" />
          ) : (
            <Eye size={12} aria-hidden="true" />
          )}
          {collisionText(t, first, rest.length)}
        </Typography>
      )}
    </Box>
  );
}

/** The pill's sentence: the first person's activity, and how many more are here. */
const collisionText = (t: ReturnType<typeof useT>, first: HeaderViewer, others: number): string => {
  if (first.activity === 'replying') {
    return others === 0
      ? t('tickets:header.replyingOne', { name: first.name })
      : t('tickets:header.replyingMany', { name: first.name, others });
  }

  return others === 0
    ? t('tickets:header.viewingOne', { name: first.name })
    : t('tickets:header.viewingMany', { name: first.name, others });
};
