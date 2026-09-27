import type {
  ActionOutcome,
  ConditionTrace,
  GroupTrace,
  RuleBuilderOptions,
  RuleCreateRequest,
  RuleTestRunOutcome,
} from '@helpdock/schemas';
import { Box, Button, InputAdornment, TextField, Typography } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Ban, Check, CircleMinus, Play, Search, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useAutomationApi } from '../../../automation/context.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { Choice } from './choice.tsx';
import type { RuleText } from './rule-text.js';

/**
 * M3-05's test run (`AdminRuleBuilder`, the aside): the draft on the form,
 * tried against a real ticket, with **nothing changed, sent or logged** — the
 * panel says so under its heading, because that is the one thing a person must
 * know before pressing the button.
 *
 * The result is a live region: what matched and why, what each action would
 * do, and what else the changes could set off one level on.
 */

const TRACE_ICON = { matched: Check, failed: X, not_needed: CircleMinus } as const;

export function TestRunPanel({
  request,
  ruleId,
  options,
  text,
}: {
  /** The draft as the api takes it, or null while the form is incomplete. */
  readonly request: RuleCreateRequest | null;
  readonly ruleId: string | null;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const api = useAutomationApi();
  const [reference, setReference] = useState('');
  const [tried, setTried] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: (draft: RuleCreateRequest) =>
      api.testRun(brand.id, {
        rule: draft,
        ticket: reference.trim(),
        ...(ruleId === null ? {} : { ruleId }),
      }),
    onSuccess: () => {
      setTried(reference.trim());
    },
  });

  const outcome = test.data?.outcome;
  const notFound = test.data !== undefined && outcome === null;
  const event =
    request === null
      ? ''
      : request.kind === 'event'
        ? text.trigger(request.trigger ?? 'ticket_created')
        : text.trigger('schedule');

  return (
    <Box
      component="aside"
      aria-labelledby="test-run-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        alignSelf: 'start',
        minWidth: 0,
      }}
    >
      <Box
        component="form"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (request !== null && reference.trim() !== '') {
            test.mutate(request);
          }
        }}
        sx={{
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Box>
          <Typography variant="h3" component="h2" id="test-run-heading">
            {t('rules:testRun.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('rules:testRun.body')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography
            component="label"
            htmlFor="test-run-ticket"
            sx={{ fontSize: 13, fontWeight: 500 }}
          >
            {t('rules:testRun.sample')}
          </Typography>
          <TextField
            id="test-run-ticket"
            type="search"
            size="small"
            value={reference}
            placeholder="HD-1042"
            onChange={(changed) => {
              setReference(changed.target.value);
            }}
            error={notFound}
            slotProps={{
              htmlInput: {
                'aria-invalid': notFound,
                ...(notFound ? { 'aria-describedby': 'test-run-missing' } : {}),
              },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={16} aria-hidden="true" />
                  </InputAdornment>
                ),
              },
            }}
          />
          {notFound ? (
            <Typography
              id="test-run-missing"
              role="alert"
              variant="caption"
              sx={{ color: tokens['status.danger.text'] }}
            >
              {t('rules:testRun.notFound', { ticket: tried ?? '', brand: brand.name })}
            </Typography>
          ) : null}
        </Box>
        {outcome == null ? null : <TicketCard outcome={outcome} />}
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography
              component="label"
              htmlFor="test-run-event"
              sx={{ fontSize: 13, fontWeight: 500 }}
            >
              {t('rules:testRun.asIf')}
            </Typography>
            <Choice id="test-run-event" value={event} onChange={() => undefined}>
              <option value={event}>{event}</option>
            </Choice>
          </Box>
          <Button
            type="submit"
            variant="outlined"
            startIcon={<Play size={16} aria-hidden="true" />}
            disabled={request === null || reference.trim() === '' || test.isPending}
          >
            {t('rules:testRun.run')}
          </Button>
        </Box>
        {request === null ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('rules:testRun.incomplete')}
          </Typography>
        ) : null}
        {test.isError ? (
          <Typography variant="caption" role="alert" sx={{ color: tokens['status.danger.text'] }}>
            {t('rules:testRun.failed')}
          </Typography>
        ) : null}
      </Box>

      <Box aria-live="polite" sx={{ padding: outcome == null ? 0 : 4 }}>
        {outcome == null ? null : <TestRunResult outcome={outcome} options={options} text={text} />}
      </Box>
    </Box>
  );
}

function TicketCard({ outcome }: { readonly outcome: RuleTestRunOutcome }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { ticket } = outcome;
  const facts = [
    ticket.contactName,
    t(`rules:channels.${ticket.channel}`),
    ticket.departmentName,
    ticket.teamName,
    ticket.assigneeName ?? t('rules:testRun.unassigned'),
    ...ticket.tagNames.map((tag) => t('rules:testRun.tag', { tag })),
  ].filter((fact): fact is string => fact !== null && fact !== '');

  return (
    <Box
      sx={{
        padding: 3,
        borderRadius: '6px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline' }}>
        <Typography variant="mono" component="span">
          <bdi>{ticket.reference}</bdi>
        </Typography>
        <Typography component="span" sx={{ fontWeight: 500 }} dir="auto">
          {ticket.subject}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
        {facts.join(' · ')}
      </Typography>
    </Box>
  );
}

function TestRunResult({
  outcome,
  options,
  text,
}: {
  readonly outcome: RuleTestRunOutcome;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone = outcome.wouldRun ? 'success' : 'warning';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box
        role="status"
        sx={{
          display: 'flex',
          gap: 2,
          padding: '10px 12px',
          borderRadius: '6px',
          border: `1px solid ${tokens[`status.${tone}`]}`,
          backgroundColor: tokens[`status.${tone}.tint`],
          color: tokens[`status.${tone}.text`],
        }}
      >
        {outcome.wouldRun ? (
          <Check size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
        ) : (
          <Ban size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
        )}
        <Typography variant="body2" sx={{ color: 'inherit' }}>
          <strong>
            {t(outcome.wouldRun ? 'rules:testRun.wouldRun' : 'rules:testRun.wouldNotRun', {
              ticket: outcome.ticket.reference,
            })}
          </strong>{' '}
          {outcome.groups.length === 0
            ? t('rules:testRun.noConditions')
            : t(outcome.wouldRun ? 'rules:testRun.matched' : 'rules:testRun.notMatched')}
        </Typography>
      </Box>

      {outcome.groups.length === 0 ? null : (
        <Box>
          <Typography variant="h3" component="h3" sx={{ fontSize: 14, marginBlockEnd: 1 }}>
            {t('rules:testRun.conditions')}
          </Typography>
          <Box
            component="ul"
            sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 1 }}
          >
            {outcome.groups.map((group, index) => (
              <GroupTraceItem key={String(index)} group={group} n={index + 1} text={text} />
            ))}
          </Box>
        </Box>
      )}

      {outcome.wouldRun ? (
        <Box>
          <Typography variant="h3" component="h3" sx={{ fontSize: 14, marginBlockEnd: 1 }}>
            {t('rules:testRun.wouldDo')}
          </Typography>
          <Box
            component="ol"
            sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 1 }}
          >
            {outcome.actions.map((outcomeOfAction, index) => (
              <ActionPreview
                key={String(index)}
                n={index + 1}
                outcome={outcomeOfAction}
                options={options}
                text={text}
              />
            ))}
          </Box>
        </Box>
      ) : null}

      {outcome.wouldRun ? (
        <Box>
          <Typography variant="h3" component="h3" sx={{ fontSize: 14, marginBlockEnd: 1 }}>
            {t('rules:testRun.couldSetOff')}
          </Typography>
          {outcome.followOns.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('rules:testRun.nothingSetOff')}
            </Typography>
          ) : (
            <Box
              component="ul"
              sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 2 }}
            >
              {outcome.followOns.map((followOn) => {
                const failed = followOn.failedGroup?.conditions.find(
                  (trace) => trace.outcome === 'failed',
                );
                return (
                  <Box component="li" key={followOn.ruleId}>
                    <Typography variant="body2">
                      {t('rules:testRun.followOn', {
                        trigger: text.trigger(followOn.trigger),
                        rule: followOn.ruleName,
                        depth: followOn.depth,
                      })}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                      {followOn.outcome === 'would_run'
                        ? t('rules:testRun.followOnRuns')
                        : followOn.outcome === 'would_stop'
                          ? t('rules:testRun.followOnStops')
                          : t('rules:testRun.followOnSkips', {
                              reason: failed === undefined ? '' : text.condition(failed.condition),
                            })}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

function GroupTraceItem({
  group,
  n,
  text,
}: {
  readonly group: GroupTrace;
  readonly n: number;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();

  return (
    <Box component="li">
      <TraceLine outcome={group.outcome}>
        <strong>{t('rules:testRun.group', { n })}</strong>
        {' · '}
        {t(group.match === 'all' ? 'rules:builder.allOf' : 'rules:builder.anyOf')}
      </TraceLine>
      <Box
        component="ul"
        sx={{ margin: 0, paddingInlineStart: 6, listStyle: 'none', display: 'grid', gap: 1 }}
      >
        {group.conditions.map((trace, index) => (
          <Box component="li" key={String(index)}>
            <TraceLine outcome={trace.outcome} detail={detailOf(trace, text, t)}>
              {text.condition(trace.condition)}
            </TraceLine>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

const detailOf = (trace: ConditionTrace, text: RuleText, t: ReturnType<typeof useT>): string => {
  if (trace.actual === null) {
    return '';
  }
  const found = text.actual(trace);
  if (trace.condition.field === 'subject' || trace.condition.field === 'body') {
    return trace.outcome === 'matched'
      ? t('rules:testRun.foundIn', { text: found })
      : t('rules:testRun.notIn', { field: text.field(trace.condition) });
  }
  return found;
};

function TraceLine({
  outcome,
  detail,
  children,
}: {
  readonly outcome: ConditionTrace['outcome'];
  readonly detail?: string;
  readonly children: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const Icon = TRACE_ICON[outcome];
  const colour =
    outcome === 'matched'
      ? tokens['status.success.text']
      : outcome === 'failed'
        ? tokens['status.danger.text']
        : tokens['text.secondary'];

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
      <Icon
        size={14}
        aria-hidden="true"
        style={{ flexShrink: 0, marginBlockStart: 3, color: colour }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" component="span">
          <Box component="span" sx={visuallyHidden}>
            {t(`rules:testRun.outcomes.${outcome}`)}{' '}
          </Box>
          {children}
        </Typography>
        {detail === undefined || detail === '' ? null : (
          <Typography
            variant="caption"
            component="div"
            sx={{ color: 'text.secondary', fontWeight: 400 }}
            dir="auto"
          >
            {detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function ActionPreview({
  n,
  outcome,
  options,
  text,
}: {
  readonly n: number;
  readonly outcome: ActionOutcome;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();
  const recipients = (outcome.recipientIds ?? [])
    .map((id) => options?.members.find((member) => member.id === id)?.name)
    .filter((name): name is string => name !== undefined);

  const detail =
    outcome.effect === 'unchanged'
      ? t('rules:testRun.effects.unchanged')
      : outcome.effect === 'unavailable'
        ? t('rules:testRun.effects.unavailable')
        : outcome.action.type === 'send_canned'
          ? t(
              outcome.action.countsAsResponse === true
                ? 'rules:testRun.effects.counts'
                : 'rules:testRun.effects.doesNotCount',
            )
          : recipients.join(t('rules:text.listSeparator'));

  return (
    <Box component="li" sx={{ display: 'flex', gap: 2 }}>
      <Typography variant="mono" component="span" sx={{ color: 'text.secondary', width: 16 }}>
        {n}
      </Typography>
      <Box>
        <Typography variant="body2">{text.action(outcome.action)}</Typography>
        {detail === '' ? null : (
          <Typography
            variant="caption"
            component="div"
            sx={{ color: 'text.secondary', fontWeight: 400 }}
          >
            {detail}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
