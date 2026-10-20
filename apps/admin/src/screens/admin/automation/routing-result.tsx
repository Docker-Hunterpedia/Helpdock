import type {
  RoutingTestAssignment,
  RoutingTestResult,
  RoutingTestRule,
  RuleBuilderOptions,
} from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { Check, Clock, Inbox, type LucideIcon, Sparkles, User, Users, X, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { departmentName, doorName } from './routing-steps.tsx';
import type { RuleText } from './rule-text.js';
import { ActionPreview, GroupTraceItem } from './test-run-panel.tsx';
import { useTimeOfDay } from './time.js';

/**
 * DESIGN §6.3 RoutingResult (M14-09): Test routing's answer, in the
 * `TestRunPanel` anatomy: a titled `ol`, each step with an outcome icon, a
 * 13/500 title and a caption, and under a rule its conditions and actions as
 * the rule test run draws them. A blocked or automated sender ends the walk
 * with a banner, because nothing after it would happen.
 */

type Translate = ReturnType<typeof useT>;
type Tone = 'success' | 'neutral' | 'warning';

function Step({
  icon: Icon,
  tone = 'neutral',
  title,
  children,
}: {
  readonly icon: LucideIcon;
  readonly tone?: Tone;
  readonly title: ReactNode;
  readonly children?: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();
  const colour =
    tone === 'success'
      ? tokens['status.success.text']
      : tone === 'warning'
        ? tokens['status.warning.text']
        : tokens['text.secondary'];

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        gap: 3,
        paddingBlock: 2,
        borderBlockStart: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box component="span" sx={{ color: colour, display: 'inline-flex', marginBlockStart: '2px' }}>
        <Icon size={16} aria-hidden="true" />
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, fontSize: 13 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {title}
        </Typography>
        {children}
      </Box>
    </Box>
  );
}

function Caption({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <Typography variant="caption" component="div" sx={{ color: 'text.secondary', fontWeight: 400 }}>
      {children}
    </Typography>
  );
}

function RuleStep({
  rule,
  options,
  text,
}: {
  readonly rule: RoutingTestRule;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();

  return (
    <Step
      icon={rule.matched ? Zap : X}
      tone={rule.matched ? 'success' : 'neutral'}
      title={t(
        rule.matched ? 'rules:routing.result.ruleMatches' : 'rules:routing.result.ruleSkips',
        {
          name: rule.name,
        },
      )}
    >
      <Box
        component="ul"
        sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 1 }}
      >
        {rule.groups.map((group, index) => (
          <GroupTraceItem key={String(index)} group={group} n={index + 1} text={text} />
        ))}
      </Box>
      {rule.actions.length === 0 ? null : (
        <Box
          component="ol"
          sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 1 }}
        >
          {rule.actions.map((outcome, index) => (
            <ActionPreview
              key={String(index)}
              n={index + 1}
              outcome={outcome}
              options={options}
              text={text}
            />
          ))}
        </Box>
      )}
      {rule.followOns.map((followOn) => {
        const failed = followOn.failedGroup?.conditions.find((trace) => trace.outcome === 'failed');
        return (
          <Caption key={followOn.ruleId}>
            {t('rules:testRun.followOn', {
              trigger: text.trigger(followOn.trigger),
              rule: followOn.ruleName,
              depth: followOn.depth,
            })}
            {' · '}
            {followOn.outcome === 'would_run'
              ? t('rules:testRun.followOnRuns')
              : followOn.outcome === 'would_stop'
                ? t('rules:testRun.followOnStops')
                : t('rules:testRun.followOnSkips', {
                    reason: failed === undefined ? '' : text.condition(failed.condition),
                  })}
          </Caption>
        );
      })}
    </Step>
  );
}

const assignmentStep = (
  t: Translate,
  assignment: RoutingTestAssignment,
  department: string,
): { title: string; body: string; tone: Tone } => {
  switch (assignment.kind) {
    case 'picked':
      return {
        tone: 'success',
        title: t('rules:routing.result.assign.picked.title', { name: assignment.assignee.name }),
        body: t('rules:routing.result.assign.picked.body', {
          mode: t(`ticketing:assignment.modes.${assignment.mode}`),
          department,
        }),
      };
    case 'rule':
      return {
        tone: 'success',
        title: t('rules:routing.result.assign.rule.title', { name: assignment.assignee.name }),
        body: t('rules:routing.result.assign.rule.body'),
      };
    case 'manual':
      return {
        tone: 'neutral',
        title: t('rules:routing.result.assign.manual.title'),
        body: t('rules:routing.result.assign.manual.body', { department }),
      };
    case 'nobody_online':
      return {
        tone: 'warning',
        title: t('rules:routing.result.assign.nobodyOnline.title', { department }),
        body: t('rules:routing.result.assign.nobodyOnline.body'),
      };
    case 'nobody_eligible':
      return {
        tone: 'warning',
        title: t('rules:routing.result.assign.nobodyEligible.title', { department }),
        body: t('rules:routing.result.assign.nobodyEligible.body'),
      };
    case 'out_of_scope':
      return {
        tone: 'neutral',
        title: t('rules:routing.result.assign.outOfScope.title'),
        body: t('rules:routing.result.assign.outOfScope.body'),
      };
  }
};

export function RoutingResult({
  result,
  from,
  options,
  text,
}: {
  readonly result: RoutingTestResult;
  /** The address as the person typed it; the api never echoes it. */
  readonly from: string;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const timeOf = useTimeOfDay();
  const { entry } = result;
  const department = departmentName(entry.department, locale);
  const entryName = doorName(t, { ...entry, platform: null, enabled: true });
  const filesKey =
    entry.reason === 'brand_first_department'
      ? 'rules:routing.result.filesFirst'
      : entry.reason === 'named_by_api'
        ? 'rules:routing.result.filesApi'
        : 'rules:routing.result.files';

  const filed = (
    <Step icon={Check} tone="success" title={department}>
      <Caption>
        {t(filesKey, { entry: entryName, department })}
        {result.verdict === 'ticket' ? ` ${t('rules:routing.result.senderOk')}` : ''}
      </Caption>
    </Step>
  );

  if (result.verdict !== 'ticket') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Typography variant="h3" component="h3" sx={{ fontSize: 14 }}>
          {t('rules:routing.result.heading')}
        </Typography>
        {result.verdict === 'blocked' ? (
          <AlertBanner tone="warning">
            {t('rules:routing.result.blocked', { from: from.trim() })}
          </AlertBanner>
        ) : (
          <AlertBanner tone="info">
            {t('rules:routing.result.automated', { from: from.trim() })}
          </AlertBanner>
        )}
      </Box>
    );
  }

  const finalDepartment =
    result.ticket === null ? department : departmentName(result.ticket.department, locale);
  const facts =
    result.ticket === null
      ? []
      : [
          result.ticket.team?.name,
          t(`rules:priorities.${result.ticket.priority}`),
          ...result.ticket.tagNames.map((tag) => t('rules:testRun.tag', { tag })),
        ].filter((fact): fact is string => fact !== undefined && fact !== '');

  const assignment =
    result.assignment === null ? null : assignmentStep(t, result.assignment, finalDepartment);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h3" component="h3" sx={{ fontSize: 14 }}>
        {t('rules:routing.result.heading')}
      </Typography>
      <Box component="ol" sx={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {filed}
        {result.contact === null ? null : result.contact.kind === 'matched' ? (
          <Step
            icon={User}
            title={t('rules:routing.result.contactMatched.title', { name: result.contact.name })}
          >
            <Caption>
              {t('rules:routing.result.contactMatched.body', {
                kind: t(`rules:routing.result.identity.${identityKey(result.contact.matchedBy)}`),
              })}
            </Caption>
          </Step>
        ) : (
          <Step icon={User} title={t('rules:routing.result.contactNew.title')}>
            <Caption>
              {result.contact.name === null
                ? t('rules:routing.result.contactNew.body')
                : t('rules:routing.result.contactNew.bodyNamed', { name: result.contact.name })}
            </Caption>
          </Step>
        )}
        {result.rules.length === 0 ? (
          <Step icon={Zap} title={t('rules:routing.result.noRules.title')}>
            <Caption>{t('rules:routing.result.noRules.body')}</Caption>
          </Step>
        ) : (
          result.rules.map((rule) => (
            <RuleStep key={rule.ruleId} rule={rule} options={options} text={text} />
          ))
        )}
        {result.ticket === null ? null : (
          <Step
            icon={Inbox}
            title={t('rules:routing.result.ticket.title', { department: finalDepartment })}
          >
            <Caption>{facts.join(' · ')}</Caption>
          </Step>
        )}
        {result.triage === null ? null : (
          <Step
            icon={Sparkles}
            title={t(
              result.triage === 'queued'
                ? 'rules:routing.result.triage.queued'
                : 'rules:routing.result.triage.notQueued',
            )}
          >
            <Caption>
              {t(
                result.triage === 'queued'
                  ? 'rules:routing.result.triage.queuedBody'
                  : 'rules:routing.result.triage.notQueuedBody',
              )}
            </Caption>
          </Step>
        )}
        {result.sla === null ? null : result.sla.policy === null ? (
          <Step icon={Clock} title={t('rules:routing.result.sla.none')}>
            <Caption>{t('rules:routing.result.sla.noneBody')}</Caption>
          </Step>
        ) : (
          <Step
            icon={Clock}
            title={t('rules:routing.result.sla.title', { policy: result.sla.policy.name })}
          >
            {result.sla.firstResponseDueAt === null ? null : (
              <Caption>
                {t('rules:routing.result.sla.due', { due: timeOf(result.sla.firstResponseDueAt) })}
              </Caption>
            )}
          </Step>
        )}
        {assignment === null ? null : (
          <Step icon={Users} tone={assignment.tone} title={assignment.title}>
            <Caption>{assignment.body}</Caption>
          </Step>
        )}
      </Box>
    </Box>
  );
}

const IDENTITY_KEYS = ['email', 'telegram', 'whatsapp', 'messenger', 'instagram'] as const;

/** The kinds a sample can match by; anything else reads as an email, the commonest. */
const identityKey = (kind: string): (typeof IDENTITY_KEYS)[number] =>
  IDENTITY_KEYS.find((key) => key === kind) ?? 'email';
