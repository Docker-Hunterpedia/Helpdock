import type {
  StatusColor,
  Ticket,
  TicketChannel,
  TicketPriority,
  TicketStatus,
} from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import {
  Clock,
  FileText,
  Mail,
  MessageCircle,
  PauseCircle,
  Plug,
  Send,
  SquarePen,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { PRIORITY_TONE, slaState, statusName } from './format.js';

/**
 * The indicators of DESIGN §6.2, as the ticket screens use them: a status pill,
 * a priority pill, the SLA timer and the channel label.
 *
 * They live here rather than in `packages/ui` because that package has no React
 * components yet (DESIGN §11 has the map; M0 shipped the tokens and the theme).
 * The anatomy is §6.2's, so moving them later is a move and not a rewrite.
 *
 * Nothing here says anything with colour alone (DESIGN §10): every badge
 * carries its own word, and the priority dot on a row has the priority in the
 * row's accessible name.
 */

type Tone = StatusColor | 'neutral';

/** A tinted pill: tint background, text in the hue's readable pair. */
function Pill({
  tone,
  children,
  solid = false,
  dot = false,
  icon,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
  /** Urgent is the one badge drawn solid (DESIGN §6.2). */
  readonly solid?: boolean;
  readonly dot?: boolean;
  readonly icon?: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  const background =
    tone === 'neutral'
      ? tokens['bg.muted']
      : solid
        ? tokens[`status.${tone}`]
        : tokens[`status.${tone}.tint`];
  const color =
    tone === 'neutral'
      ? tokens['text.secondary']
      : solid
        ? tokens['text.inverse']
        : tokens[`status.${tone}.text`];

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        height: 22,
        paddingInline: 2,
        borderRadius: '999px',
        backgroundColor: background,
        color,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        ...(tone === 'neutral' ? { border: `1px solid ${tokens['border.default']}` } : {}),
      }}
    >
      {dot ? (
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor:
              tone === 'neutral' ? tokens['border.strong'] : tokens[`status.${tone}`],
            flexShrink: 0,
          }}
        />
      ) : null}
      {icon}
      {children}
    </Box>
  );
}

export function StatusBadge({ status }: { readonly status: TicketStatus }): ReactNode {
  const { locale } = usePreferences();

  return (
    <Pill tone={status.color} dot>
      {statusName(status, locale)}
    </Pill>
  );
}

/** DESIGN §6.2: Urgent is solid danger; everything else is an outline. */
export function PriorityBadge({ priority }: { readonly priority: TicketPriority }): ReactNode {
  const t = useT();

  return (
    <Pill tone={PRIORITY_TONE[priority]} solid={priority === 'urgent'}>
      {t(`tickets:priority.${priority}`)}
    </Pill>
  );
}

/** The 8 px dot at the start of a `TicketRow`. Decorative: the row names it. */
export function PriorityDot({ priority }: { readonly priority: TicketPriority }): ReactNode {
  const tokens = useSemanticTokens();
  const tone = PRIORITY_TONE[priority];

  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        width: 8,
        height: 8,
        flexShrink: 0,
        borderRadius: '50%',
        backgroundColor: tone === 'neutral' ? tokens['border.strong'] : tokens[`status.${tone}`],
      }}
    />
  );
}

/**
 * DESIGN §6.2 SlaTimer. Four states: running, at risk, breached and paused —
 * and a fifth that draws nothing at all, because a ticket no policy covers has
 * no clock and an empty timer would read as zero.
 */
export function SlaTimer({
  ticket,
  now,
  compact = false,
}: {
  readonly ticket: Ticket;
  readonly now: number;
  /** The list prints the time alone; the header prints the whole sentence. */
  readonly compact?: boolean;
}): ReactNode {
  const t = useT();
  const state = slaState(ticket, now);

  if (state.kind === 'none') {
    return null;
  }

  if (state.kind === 'paused') {
    return (
      <Pill tone="neutral" icon={<PauseCircle size={12} aria-hidden="true" />}>
        {t('tickets:sla.paused')}
      </Pill>
    );
  }

  if (state.kind === 'breached') {
    const key =
      ticket.firstResponseDueAt === null
        ? 'tickets:sla.breachedResolution'
        : 'tickets:sla.breachedFirstResponse';

    return (
      <Pill tone="danger" icon={<Clock size={12} aria-hidden="true" />}>
        {compact ? `-${state.over}` : t(key, { over: state.over })}
      </Pill>
    );
  }

  return (
    <Pill
      tone={state.kind === 'atRisk' ? 'warning' : 'success'}
      icon={<Clock size={12} aria-hidden="true" />}
    >
      {compact ? state.remaining : t('tickets:sla.running', { remaining: state.remaining })}
    </Pill>
  );
}

const CHANNEL_ICONS = {
  email: Mail,
  chat: MessageCircle,
  telegram: Send,
  form: FileText,
  api: Plug,
  manual: SquarePen,
} as const;

/** DESIGN §6.2 ChannelIcon: a 14 px icon and the channel's name beside it. */
export function ChannelLabel({
  channel,
  departmentName,
}: {
  readonly channel: TicketChannel;
  readonly departmentName?: string | undefined;
}): ReactNode {
  const t = useT();
  const Icon = CHANNEL_ICONS[channel];

  return (
    <Typography
      variant="caption"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}
    >
      <Icon size={14} aria-hidden="true" />
      {departmentName === undefined
        ? t(`tickets:channel.${channel}`)
        : `${t(`tickets:channel.${channel}`)} · ${departmentName}`}
    </Typography>
  );
}
