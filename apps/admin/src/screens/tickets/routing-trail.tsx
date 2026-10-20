import type {
  RoutingActor,
  RoutingChange,
  RoutingDepartment,
  RoutingOrigin,
  RoutingStep,
  TicketArrivalEntry,
  TicketRouting,
} from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import {
  ChevronDown,
  ChevronRight,
  Cog,
  Import,
  type LucideIcon,
  Route,
  Sparkles,
  Timer,
  User,
  Zap,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Trans } from 'react-i18next';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { CHANNEL_ICONS } from './badges.tsx';
import { messageTime } from './format.js';

/**
 * DESIGN §6.3 RoutingTrail (M14-08, `Admin/Ticket-Routing`): "How it got
 * here" in the DetailsPanel, under the SLA card.
 *
 * Collapsed by default to one summary line; expanded, the arrival and then
 * each automatic department, team, priority and assignee change the api found
 * before a person first changed the ticket. Every step names its source — the
 * mailbox or channel, the rule ("a rule since deleted" when it is gone), AI
 * triage, the assignment mode — so nothing reads as magic. The words are
 * composed here from the api's structured trail, in the reader's language.
 */

export interface RoutingTrailProps {
  /** `undefined` while the read has not answered. */
  readonly routing: TicketRouting | undefined;
  readonly failed: boolean;
  readonly now: number;
  onRetry(): void;
}

type Translate = ReturnType<typeof useT>;
type Locale = 'en' | 'ar';

const ACTOR_ICONS: Record<RoutingActor['kind'], LucideIcon> = {
  rule: Zap,
  // DESIGN §5: AI is `sparkles` everywhere.
  ai_triage: Sparkles,
  assignment: User,
  sla: Timer,
  system: Cog,
};

const PRIORITY_RANK = { low: 0, medium: 1, high: 2, urgent: 3 } as const;

/** The entry points whose own department the arrival names in words; the rest say "the entry point's". */
const NAMED_ENTRY_DEPARTMENTS = ['mailbox', 'web_form', 'telegram_bot', 'meta_account'] as const;
const namesItsDepartment = (
  entry: TicketArrivalEntry,
): entry is (typeof NAMED_ENTRY_DEPARTMENTS)[number] =>
  (NAMED_ENTRY_DEPARTMENTS as readonly TicketArrivalEntry[]).includes(entry);

const departmentName = (department: RoutingDepartment, locale: Locale, t: Translate): string =>
  (locale === 'ar' ? department.nameAr : null) ??
  department.name ??
  t('tickets:routing.gone.department');

/** "by rule “Invoices to Billing”", "by AI triage", "by round-robin". */
function By({ by }: { readonly by: RoutingActor }): ReactNode {
  switch (by.kind) {
    case 'ai_triage':
      return <Trans ns="tickets" i18nKey="routing.by.ai_triage" />;
    case 'rule':
      return by.name === null ? (
        <Trans ns="tickets" i18nKey="routing.by.ruleDeleted" />
      ) : (
        <Trans
          ns="tickets"
          i18nKey="routing.by.rule"
          values={{ name: by.name }}
          components={{ bdi: <bdi /> }}
        />
      );
    case 'assignment':
      return (
        <Trans
          ns="tickets"
          i18nKey={
            by.mode === 'round_robin' || by.mode === 'skill_based'
              ? `routing.by.${by.mode}`
              : 'routing.by.rotation'
          }
        />
      );
    case 'sla':
      return <Trans ns="tickets" i18nKey="routing.by.sla" />;
    case 'system':
      return <Trans ns="tickets" i18nKey="routing.by.system" />;
  }
}

/** What one step moved, without its actor. */
function Change({ change }: { readonly change: RoutingChange }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const bdi = { bdi: <bdi /> };
  switch (change.kind) {
    case 'moved': {
      if (change.department !== undefined) {
        const department = departmentName(change.department, locale, t);
        return change.team == null ? (
          <Trans
            ns="tickets"
            i18nKey="routing.change.moved"
            values={{ department }}
            components={bdi}
          />
        ) : (
          <Trans
            ns="tickets"
            i18nKey="routing.change.movedWithTeam"
            values={{ department, team: change.team.name ?? t('tickets:routing.gone.team') }}
            components={bdi}
          />
        );
      }
      return change.team == null ? (
        <Trans ns="tickets" i18nKey="routing.change.teamCleared" />
      ) : (
        <Trans
          ns="tickets"
          i18nKey="routing.change.team"
          values={{ team: change.team.name ?? t('tickets:routing.gone.team') }}
          components={bdi}
        />
      );
    }
    case 'priority':
      return (
        <Trans
          ns="tickets"
          i18nKey={
            change.from === null
              ? 'routing.change.prioritySet'
              : PRIORITY_RANK[change.to] > PRIORITY_RANK[change.from]
                ? 'routing.change.priorityRaised'
                : 'routing.change.priorityLowered'
          }
          values={{ priority: t(`tickets:priority.${change.to}`) }}
        />
      );
    case 'assigned':
      return change.assignee === null ? (
        <Trans ns="tickets" i18nKey="routing.change.unassigned" />
      ) : (
        <Trans
          ns="tickets"
          i18nKey="routing.change.assigned"
          values={{ name: change.assignee.name ?? t('tickets:routing.gone.person') }}
          components={bdi}
        />
      );
  }
}

/** The arrival's first line: "Arrived at support@acme.com", "Arrived through the chat widget". */
function Arrival({
  origin,
  form,
}: {
  readonly origin: RoutingOrigin;
  readonly form: 'summary' | 'arrived';
}): ReactNode {
  const t = useT();
  switch (origin.kind) {
    case 'imported':
      return t('tickets:routing.imported.title', { source: t(`imports:sources.${origin.source}`) });
    case 'unrecorded':
      return t(`tickets:routing.unrecorded.${origin.channel}`);
    case 'recorded':
      // An import's arrival is answered as `imported`, from the ticket's own source.
      if (origin.entry === 'import') {
        return t(`tickets:routing.unrecorded.${origin.channel}`);
      }
      return origin.entry === 'mailbox' && origin.address === null ? (
        t(`tickets:routing.${form}.mailboxNoAddress`)
      ) : (
        <Trans
          ns="tickets"
          i18nKey={`routing.${form}.${origin.entry}`}
          values={{
            address: origin.address ?? '',
            channel: t(`tickets:channel.${origin.channel}`),
          }}
          components={{ bdi: <bdi /> }}
        />
      );
  }
}

/** The arrival's second line: "Billing · the mailbox's department". */
const arrivalDetail = (origin: RoutingOrigin, locale: Locale, t: Translate): string => {
  switch (origin.kind) {
    case 'imported':
      return t('tickets:routing.imported.detail');
    case 'unrecorded':
      return t('tickets:routing.unrecorded.detail');
    case 'recorded': {
      const reason =
        origin.reason === 'entry_department'
          ? t(
              `tickets:routing.reason.entry_department.${namesItsDepartment(origin.entry) ? origin.entry : 'other'}`,
            )
          : t(`tickets:routing.reason.${origin.reason}`);
      return `${departmentName(origin.department, locale, t)} · ${reason}`;
    }
  }
};

const arrivalIcon = (origin: RoutingOrigin): LucideIcon =>
  origin.kind === 'imported' ? Import : CHANNEL_ICONS[origin.channel];

/** "Email to support@acme.com → Billing · assigned by round-robin". */
function Summary({ routing }: { readonly routing: TicketRouting }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const { origin, steps } = routing;
  if (origin.kind !== 'recorded') {
    return <Arrival origin={origin} form="summary" />;
  }
  const moved = steps.findLast(
    (step): step is RoutingStep & { change: { kind: 'moved'; department: RoutingDepartment } } =>
      step.change.kind === 'moved' && step.change.department !== undefined,
  );
  const assigned = steps.findLast(
    (step) => step.change.kind === 'assigned' && step.change.assignee !== null,
  );
  return (
    <>
      <Arrival origin={origin} form="summary" />
      {` ${t('tickets:routing.arrow')} `}
      <bdi>{departmentName(moved?.change.department ?? origin.department, locale, t)}</bdi>
      {assigned === undefined ? null : (
        <>
          {` · ${t('tickets:routing.summary.assigned')} `}
          <By by={assigned.by} />
        </>
      )}
    </>
  );
}

function Step({
  icon: Icon,
  title,
  caption,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly caption: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  return (
    <Box component="li" sx={{ display: 'flex', gap: 2 }}>
      <Box
        aria-hidden="true"
        sx={{
          inlineSize: 24,
          blockSize: 24,
          flexShrink: 0,
          borderRadius: '999px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens['bg.muted'],
          color: tokens['text.secondary'],
        }}
      >
        <Icon size={14} />
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography variant="body2" component="span" sx={{ overflowWrap: 'anywhere' }}>
          {title}
        </Typography>
        <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
          {caption}
        </Typography>
      </Box>
    </Box>
  );
}

export function RoutingTrail({ routing, failed, now, onRetry }: RoutingTrailProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const bodyId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;

  const body = failed ? (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:routing.failed')}
      </Typography>
      <Button size="small" variant="text" onClick={onRetry}>
        {t('tickets:routing.retry')}
      </Button>
    </Box>
  ) : routing === undefined ? (
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
      {t('tickets:routing.loading')}
    </Typography>
  ) : open ? (
    <Box
      component="ol"
      sx={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <Step
        icon={arrivalIcon(routing.origin)}
        title={<Arrival origin={routing.origin} form="arrived" />}
        caption={<bdi>{arrivalDetail(routing.origin, locale, t)}</bdi>}
      />
      {routing.steps.map((step, index) => (
        <Step
          // A step has no id: two changes of one activity row share a time.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is the api's, read-only and never reordered.
          key={index}
          icon={ACTOR_ICONS[step.by.kind]}
          title={
            <>
              <Change change={step.change} /> <By by={step.by} />
            </>
          }
          caption={<bdi>{messageTime(step.at, locale, now)}</bdi>}
        />
      ))}
    </Box>
  ) : (
    <Typography variant="caption" component="p" sx={{ margin: 0, color: 'text.secondary' }}>
      <Summary routing={routing} />
    </Typography>
  );

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      aria-busy={routing === undefined && !failed}
      sx={{
        padding: 3,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: open ? 2 : 1,
      }}
    >
      <Typography variant="bodyStrong" component="h2" id={headingId} sx={{ margin: 0 }}>
        <Box
          component="button"
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen((value) => !value);
          }}
          sx={{
            inlineSize: '100%',
            blockSize: 32,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: 0,
            border: 0,
            borderRadius: '6px',
            background: 'transparent',
            color: 'text.primary',
            font: 'inherit',
            cursor: 'pointer',
            '&:focus-visible': {
              outline: `2px solid ${tokens['border.focus']}`,
              outlineOffset: '2px',
            },
          }}
        >
          <Route size={14} aria-hidden="true" />
          <Box component="span" sx={{ flexGrow: 1, textAlign: 'start' }}>
            {t('tickets:routing.heading')}
          </Box>
          <Box
            component="span"
            aria-hidden="true"
            sx={{
              display: 'inline-flex',
              transform: !open && locale === 'ar' ? 'scaleX(-1)' : undefined,
            }}
          >
            <Chevron size={14} />
          </Box>
        </Box>
      </Typography>
      <Box id={bodyId}>{body}</Box>
    </Box>
  );
}
