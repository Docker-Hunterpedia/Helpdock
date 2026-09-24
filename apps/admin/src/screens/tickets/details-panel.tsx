import type {
  ContactDetail,
  Department,
  Ticket,
  TicketPriority,
  TicketStatus,
} from '@helpdock/schemas';
import { ticketPrioritySchema } from '@helpdock/schemas';
import { Box, MenuItem, Link as MuiLink, TextField, Typography } from '@mui/material';
import { BadgeCheck, Lock } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { contactRoute, ticketRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { initialsOf } from '../contacts/format.js';
import { ChannelLabel } from './badges.tsx';
import { elapsedFraction, messageTime, statusName } from './format.js';
import { ParticipantsCard } from './participants-card.tsx';

/**
 * DESIGN §6.3 DetailsPanel: 300 px on `bg.surface`, a contact card, labelled
 * fields, the SLA card on `bg.canvas` with its 4 px bar, custom fields and
 * linked tickets.
 *
 * Four of the fields are **selects rather than labels**, because they are what
 * an agent changes while reading — assignee, department, status and priority
 * all go through the one `PATCH` M1-02 gave us. Two are read-only and will
 * stay that way until their own deliverable: custom fields are M1-06's, and
 * linked tickets are M1-08's `parent_id` and M1-09's merge and split.
 *
 * **The hidden-ticket count is the contact's, not the ticket's**
 * (DOMAIN-RULES §1.2). It comes from the contact timeline, which is the one
 * place the api says how much history a viewer's departments exclude, and it
 * says a number and nothing else.
 */

export const DETAILS_WIDTH = 300;

export interface DetailsPanelProps {
  readonly ticket: Ticket;
  readonly contact: ContactDetail | null;
  readonly hiddenTicketCount: number;
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly staff: readonly { readonly userId: string; readonly name: string }[];
  readonly now: number;
  readonly busy: boolean;
  onChange(patch: {
    statusId?: string;
    priority?: TicketPriority;
    departmentId?: string;
    assigneeId?: string | null;
  }): void;
}

export function DetailsPanel({
  ticket,
  contact,
  hiddenTicketCount,
  statuses,
  departments,
  staff,
  now,
  busy,
  onChange,
}: DetailsPanelProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const assigneeId = useId();
  const departmentId = useId();
  const statusId = useId();
  const priorityId = useId();

  const custom = Object.entries(ticket.custom);
  const linked = [ticket.parentId, ticket.mergedIntoId, ticket.splitFromId].filter(
    (value): value is string => value !== null,
  );

  return (
    <Box
      component="aside"
      aria-label={t('tickets:details.label')}
      sx={{
        width: { xs: '100%', md: DETAILS_WIDTH },
        flexShrink: 0,
        padding: 5,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        overflowY: 'auto',
        backgroundColor: tokens['bg.surface'],
        borderInlineStart: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box component="section">
        <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
          {t('tickets:details.contact')}
        </Typography>

        {contact === null ? (
          <Typography variant="body2" sx={{ marginBlockStart: 2 }}>
            {t('tickets:details.noContact')}
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start', marginBlockStart: 2 }}>
            <Box
              aria-hidden="true"
              sx={{
                width: 28,
                height: 28,
                flexShrink: 0,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: 12,
                fontWeight: 600,
                backgroundColor: tokens['bg.muted'],
                color: tokens['text.secondary'],
              }}
            >
              {initialsOf(contact.name)}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <MuiLink component={Link} to={contactRoute(contact.id)} variant="bodyStrong">
                {contact.name}
              </MuiLink>
              {contact.primaryIdentity === null ? null : (
                <Typography
                  variant="caption"
                  component="p"
                  sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 1 }}
                >
                  <bdi>{contact.primaryIdentity.value}</bdi>
                  {contact.primaryIdentity.verified ? (
                    <>
                      <BadgeCheck size={12} aria-hidden="true" color={tokens['status.success']} />
                      {t('tickets:details.verified')}
                    </>
                  ) : (
                    t('tickets:details.unverified')
                  )}
                </Typography>
              )}
              {hiddenTicketCount > 0 ? (
                <Typography
                  variant="caption"
                  component="p"
                  sx={{
                    marginBlockStart: 1,
                    color: tokens['status.warning.text'],
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                  }}
                >
                  <Lock size={12} aria-hidden="true" />
                  {t('tickets:details.hiddenTickets', { count: hiddenTicketCount })}
                </Typography>
              ) : null}
            </Box>
          </Box>
        )}
      </Box>

      {/* M1-13: the contact, the CCs and a field to copy somebody in. */}
      <ParticipantsCard ticketId={ticket.id} />

      <TextField
        id={assigneeId}
        select
        size="small"
        disabled={busy}
        label={t('tickets:details.assignee')}
        value={ticket.assigneeId ?? ''}
        onChange={(event) => {
          onChange({ assigneeId: event.target.value === '' ? null : event.target.value });
        }}
      >
        <MenuItem value="">{t('tickets:details.unassigned')}</MenuItem>
        {staff.map((member) => (
          <MenuItem key={member.userId} value={member.userId}>
            {member.name}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        id={departmentId}
        select
        size="small"
        disabled={busy || departments.length === 0}
        label={t('tickets:details.department')}
        value={departments.some((d) => d.id === ticket.departmentId) ? ticket.departmentId : ''}
        onChange={(event) => {
          onChange({ departmentId: event.target.value });
        }}
      >
        {departments.map((department) => (
          <MenuItem key={department.id} value={department.id}>
            {department.name}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        id={statusId}
        select
        size="small"
        disabled={busy}
        label={t('tickets:details.status')}
        value={ticket.status.id}
        onChange={(event) => {
          onChange({ statusId: event.target.value });
        }}
      >
        {statuses.map((status) => (
          <MenuItem key={status.id} value={status.id}>
            {statusName(status, locale)}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        id={priorityId}
        select
        size="small"
        disabled={busy}
        label={t('tickets:details.priority')}
        value={ticket.priority}
        onChange={(event) => {
          onChange({ priority: event.target.value as TicketPriority });
        }}
      >
        {ticketPrioritySchema.options.map((priority) => (
          <MenuItem key={priority} value={priority}>
            {t(`tickets:priority.${priority}`)}
          </MenuItem>
        ))}
      </TextField>

      <SlaCard ticket={ticket} now={now} />

      <Box component="section">
        <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
          {t('tickets:details.channel')}
        </Typography>
        <Box sx={{ marginBlockStart: 2 }}>
          <ChannelLabel channel={ticket.channel} />
        </Box>
      </Box>

      <Box component="section">
        <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
          {t('tickets:details.custom')}
        </Typography>
        {custom.length === 0 ? (
          <Typography variant="body2" sx={{ marginBlockStart: 2, color: 'text.secondary' }}>
            {t('tickets:details.noCustom')}
          </Typography>
        ) : (
          <Box component="dl" sx={{ margin: 0, marginBlockStart: 2, display: 'grid', gap: 2 }}>
            {custom.map(([key, value]) => (
              <Box key={key} sx={{ display: 'flex', justifyContent: 'space-between', gap: 3 }}>
                <Typography component="dt" variant="caption" sx={{ color: 'text.secondary' }}>
                  {key}
                </Typography>
                <Typography component="dd" variant="mono" sx={{ margin: 0, fontSize: 12 }}>
                  <bdi>{String(value)}</bdi>
                </Typography>
              </Box>
            ))}
          </Box>
        )}
        <Typography
          variant="caption"
          component="p"
          sx={{ marginBlockStart: 2, color: 'text.secondary' }}
        >
          {t('tickets:details.customReadOnly')}
        </Typography>
      </Box>

      <Box component="section">
        <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
          {t('tickets:details.linked')}
        </Typography>
        {linked.length === 0 ? (
          <Typography variant="body2" sx={{ marginBlockStart: 2, color: 'text.secondary' }}>
            {t('tickets:details.noLinked')}
          </Typography>
        ) : (
          <Box
            component="ul"
            sx={{ margin: 0, marginBlockStart: 2, padding: 0, listStyle: 'none' }}
          >
            {linked.map((id) => (
              <Box component="li" key={id}>
                <MuiLink component={Link} to={ticketRoute(id)} variant="body2">
                  <bdi>{id.slice(0, 8)}</bdi>
                </MuiLink>
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {`${t('tickets:details.created')} · `}
        <bdi>{messageTime(ticket.createdAt, locale, now)}</bdi>
      </Typography>
    </Box>
  );
}

/** The SLA card of §6.3: on `bg.canvas`, with a 4 px bar of how much is gone. */
function SlaCard({ ticket, now }: { readonly ticket: Ticket; readonly now: number }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const due = ticket.firstResponseDueAt ?? ticket.resolutionDueAt;

  return (
    <Box
      component="section"
      sx={{
        padding: 4,
        borderRadius: '8px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Typography variant="caption" component="h2" sx={{ color: 'text.secondary' }}>
        {t('tickets:details.sla')}
      </Typography>

      {due === null ? (
        <Typography variant="body2" sx={{ marginBlockStart: 2, color: 'text.secondary' }}>
          {t('tickets:details.slaNone')}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" component="p" sx={{ marginBlockStart: 2 }}>
            {`${t(
              ticket.firstResponseDueAt === null
                ? 'tickets:details.resolution'
                : 'tickets:details.firstResponse',
            )} · `}
            <bdi>{messageTime(due, locale, now)}</bdi>
          </Typography>
          <Box
            aria-hidden="true"
            sx={{
              marginBlockStart: 3,
              height: 4,
              borderRadius: '2px',
              backgroundColor: tokens['border.default'],
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                width: `${elapsedFraction(ticket.createdAt, due, now) * 100}%`,
                height: '100%',
                backgroundColor:
                  ticket.slaBreached || Date.parse(due) <= now
                    ? tokens['status.danger']
                    : tokens['action.primary'],
              }}
            />
          </Box>
        </>
      )}
    </Box>
  );
}
