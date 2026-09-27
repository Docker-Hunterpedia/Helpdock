import type { SlaState, Ticket, TicketSla, TicketSlaClock } from '@helpdock/schemas';
import type { SemanticTokenName } from '@helpdock/ui';
import { Box, Link, Typography } from '@mui/material';
import { Bell, Check, CircleAlert, Flag, PauseCircle, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { ticketingRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { clockDuration, messageTime } from './format.js';

/**
 * DESIGN §6.3 SlaCard (M3-02, artboard `Admin/Ticket-SLA`): the DetailsPanel's
 * SLA card, drawn from the clocks the api judged.
 *
 * Every state of the artboard — running, warning, paused, breached, met,
 * reopened and no policy — is the same anatomy: a caption naming the policy,
 * one row per current clock, a 4 px bar for the unsatisfied clock due first,
 * and one line saying what happened last. "Time left" is business time left
 * at the moment of the read, so the card does not tick; the `/staff` socket
 * refreshes it when a clock moves.
 */

const STATE_TONE: Record<SlaState, SemanticTokenName> = {
  running: 'status.success',
  warning: 'status.warning',
  breached: 'status.danger',
  paused: 'text.secondary',
  met: 'status.success',
  none: 'text.secondary',
};

export function SlaCard({
  ticket,
  sla,
  statusLabel,
  departmentName,
  now,
  canConfigure,
}: {
  readonly ticket: Ticket;
  /** `undefined` while the read has not said; `null` when no policy applies. */
  readonly sla: TicketSla | null | undefined;
  readonly statusLabel: string;
  readonly departmentName: string;
  readonly now: number;
  /** Whether the reader may open Ticketing › SLAs, which the empty state links to. */
  readonly canConfigure: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const time = (iso: string): string => messageTime(iso, locale, now);

  const none = sla == null || sla.state === 'none' || sla.clocks.length === 0;
  const leading = none ? undefined : leadingClock(sla.clocks);

  return (
    <Box
      component="section"
      aria-labelledby="sla-card-heading"
      sx={{
        padding: 4,
        borderRadius: '8px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Typography
        variant="caption"
        component="h2"
        id="sla-card-heading"
        sx={{ color: 'text.secondary' }}
      >
        {none || sla.policyName === null
          ? t('tickets:slaCard.heading')
          : t('tickets:slaCard.headingPolicy', { policy: sla.policyName })}
      </Typography>

      {none ? (
        <Box>
          <Typography variant="body2">{t('tickets:slaCard.none')}</Typography>
          <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
            {t('tickets:slaCard.noneDetail', {
              department: departmentName,
              priority: t(`tickets:priority.${ticket.priority}`),
            })}{' '}
            {canConfigure ? (
              <Link component={RouterLink} to={ticketingRoute('slas')}>
                {t('tickets:slaCard.policiesLink')}
              </Link>
            ) : null}
          </Typography>
        </Box>
      ) : (
        <>
          {sla.clocks.map((clock) => (
            <ClockRow key={clock.kind} clock={clock} now={now} time={time} />
          ))}

          {leading === undefined ? null : (
            <Box
              role="progressbar"
              aria-label={t('tickets:slaCard.progress', {
                clock: t(`tickets:slaCard.clock.${leading.kind}`),
              })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fractionOf(leading) * 100)}
              sx={{
                blockSize: 4,
                borderRadius: '2px',
                backgroundColor: tokens['border.default'],
                overflow: 'hidden',
              }}
            >
              <Box
                sx={{
                  inlineSize: `${fractionOf(leading) * 100}%`,
                  blockSize: '100%',
                  backgroundColor: tokens[STATE_TONE[sla.state]],
                }}
              />
            </Box>
          )}

          <Footer sla={sla} ticket={ticket} statusLabel={statusLabel} time={time} />
        </>
      )}
    </Box>
  );
}

function ClockRow({
  clock,
  now,
  time,
}: {
  readonly clock: TicketSlaClock;
  readonly now: number;
  time(iso: string): string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const remaining = clock.targetMinutes * 60_000 - clock.elapsedMs;
  const state = clockStateOf(clock);

  const reading = ((): { icon: ReactNode; text: string; sub: string | null } => {
    switch (state) {
      case 'breached':
        return {
          icon: <CircleAlert size={14} aria-hidden="true" />,
          text: t('tickets:slaCard.breached', {
            over: clockDuration(now - Date.parse(clock.breachedAt ?? new Date(now).toISOString())),
          }),
          sub:
            clock.breachedAt === null
              ? null
              : t('tickets:slaCard.wasDue', { time: time(clock.breachedAt) }),
        };
      case 'met':
        return {
          icon: <Check size={14} aria-hidden="true" />,
          text: t('tickets:slaCard.met', { elapsed: clockDuration(clock.elapsedMs) }),
          sub: null,
        };
      case 'paused':
        return {
          icon: <PauseCircle size={14} aria-hidden="true" />,
          text: t('tickets:slaCard.left', { remaining: clockDuration(remaining) }),
          sub: t('tickets:slaCard.pausedNoDue'),
        };
      default:
        return {
          icon: null,
          text: t('tickets:slaCard.left', { remaining: clockDuration(remaining) }),
          sub: clock.dueAt === null ? null : t('tickets:slaCard.due', { time: time(clock.dueAt) }),
        };
    }
  })();

  const tone =
    state === 'running' && remaining / (clock.targetMinutes * 60_000) < 0.2
      ? STATE_TONE.warning
      : STATE_TONE[state];

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
      <Box sx={{ flex: 1, minInlineSize: 0 }}>
        <Typography variant="body2">{t(`tickets:slaCard.clock.${clock.kind}`)}</Typography>
        {reading.sub === null ? null : (
          <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
            <bdi>{reading.sub}</bdi>
          </Typography>
        )}
      </Box>
      <Typography
        variant="mono"
        component="span"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: tokens[tone] }}
      >
        {reading.icon}
        {reading.text}
      </Typography>
    </Box>
  );
}

function Footer({
  sla,
  ticket,
  statusLabel,
  time,
}: {
  readonly sla: TicketSla;
  readonly ticket: Ticket;
  readonly statusLabel: string;
  time(iso: string): string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  const line = ((): { icon: ReactNode; text: string; tone: SemanticTokenName } | null => {
    const paused = sla.clocks.find((clock) => clock.pausedAt !== null);
    if (sla.state === 'paused' && paused?.pausedAt != null) {
      return {
        icon: <PauseCircle size={14} aria-hidden="true" />,
        text: t('tickets:slaCard.pausedSince', {
          time: time(paused.pausedAt),
          status: statusLabel,
        }),
        tone: 'text.secondary',
      };
    }
    if ((sla.state === 'warning' || sla.state === 'breached') && sla.lastStep !== null) {
      const leads = sla.lastStep.actions.some(
        (action) => action.type === 'notify' && action.recipient.kind === 'department_leads',
      );
      const escalated = sla.lastStep.actions.some((action) => action.type === 'set_escalated');
      const parts = [
        escalated
          ? t('tickets:slaCard.escalatedAt', { percent: sla.lastStep.percent })
          : t('tickets:slaCard.stepRan', {
              percent: sla.lastStep.percent,
              time: time(sla.lastStep.firedAt),
            }),
        ...(leads ? [t('tickets:slaCard.leadsNotified')] : []),
      ];
      return {
        icon: escalated ? (
          <Flag size={14} aria-hidden="true" />
        ) : (
          <Bell size={14} aria-hidden="true" />
        ),
        text: parts.join(' · '),
        tone: sla.state === 'breached' ? 'status.danger' : 'status.warning',
      };
    }
    if (sla.reopenedAt !== null) {
      return {
        icon: <RotateCcw size={14} aria-hidden="true" />,
        text: [
          t('tickets:slaCard.reopened', { time: time(sla.reopenedAt) }),
          ...(sla.initialResponse === null
            ? []
            : [t(`tickets:slaCard.initial.${sla.initialResponse}`)]),
        ].join(' · '),
        tone: 'text.secondary',
      };
    }
    if (sla.state === 'met' && ticket.closedAt !== null) {
      return {
        icon: <Check size={14} aria-hidden="true" />,
        text: t('tickets:slaCard.closed', { time: time(ticket.closedAt) }),
        tone: 'status.success',
      };
    }
    return null;
  })();

  if (line === null) {
    return null;
  }

  return (
    <Typography
      variant="caption"
      component="p"
      sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, color: tokens[line.tone] }}
    >
      <Box component="span" sx={{ flexShrink: 0, paddingBlockStart: 0.25 }}>
        {line.icon}
      </Box>
      <bdi>{line.text}</bdi>
    </Typography>
  );
}

const clockStateOf = (clock: TicketSlaClock): SlaState => {
  if (clock.breachedAt !== null) {
    return 'breached';
  }
  if (clock.satisfiedAt !== null) {
    return 'met';
  }
  if (clock.pausedAt !== null) {
    return 'paused';
  }
  return 'running';
};

/** The bar follows the unsatisfied clock due first; with none left, the resolution clock. */
const leadingClock = (clocks: readonly TicketSlaClock[]): TicketSlaClock | undefined => {
  const open = clocks
    .filter((clock) => clock.satisfiedAt === null && clock.stoppedAt === null)
    .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  return open[0] ?? clocks.find((clock) => clock.kind === 'resolution') ?? clocks[0];
};

const fractionOf = (clock: TicketSlaClock): number =>
  Math.min(Math.max(clock.elapsedMs / (clock.targetMinutes * 60_000), 0), 1);
