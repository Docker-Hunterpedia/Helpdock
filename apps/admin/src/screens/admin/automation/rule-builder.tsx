import {
  RULE_DESCRIPTION_MAX_LENGTH,
  RULE_INTERVALS_MINUTES,
  RULE_NAME_MAX_LENGTH,
  type RuleInterval,
  type RuleKind,
  type RuleMatch,
  ruleTriggerSchema,
  type WorkflowRule,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  Link as MuiLink,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { automationRoute, ruleRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { automationKeys } from '../../../automation/api.js';
import { useAutomationApi } from '../../../automation/context.tsx';
import { Field } from '../../../ui/field.tsx';
import { Switch } from '../../../ui/switch.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { useTicketingAction, useTicketingReport } from '../ticketing/use-ticketing-action.js';
import { ActionRow } from './action-row.tsx';
import { Choice } from './choice.tsx';
import { ConditionRow } from './condition-row.tsx';
import {
  actionDraft,
  draftOf,
  emptyDraft,
  type GroupDraft,
  moveItem,
  newAction,
  newCondition,
  newGroup,
  type RuleDraftState,
  requestOf,
} from './rule-draft.js';
import { useRuleText } from './rule-text.js';
import { TestRunPanel } from './test-run-panel.tsx';
import { useTimeOfDay } from './time.js';

/**
 * The rule builder (M3-05, `AdminRuleBuilder`): When, If, Then, and the test
 * run beside them. One form for both kinds; "Runs" switches between an event
 * and a schedule, which is the artboard's "same builder, time-based rule".
 *
 * Saving sends the whole rule (`PUT`), and is offered only once every
 * condition and action is complete — `requestOf` is the same schema the api
 * validates with, so the button and the server cannot disagree. The test run
 * reads the same request, so what is tried is exactly what would be saved.
 */

export function RuleBuilder({
  ruleId,
  rule,
  loading,
  newKind,
  position,
}: {
  /** Null for a new rule. */
  readonly ruleId: string | null;
  readonly rule: WorkflowRule | undefined;
  readonly loading: boolean;
  readonly newKind: RuleKind;
  readonly position: number;
}): ReactNode {
  const t = useT();

  if (ruleId !== null && rule === undefined) {
    return loading ? null : (
      <Typography role="alert" variant="body2">
        {t('rules:builder.missing')}{' '}
        <MuiLink component={Link} to={automationRoute('rules')}>
          {t('rules:builder.backToRules')}
        </MuiLink>
      </Typography>
    );
  }

  return (
    <BuilderForm
      ruleId={ruleId}
      rule={rule}
      initial={rule === undefined ? emptyDraft(newKind) : draftOf(rule)}
      position={position}
    />
  );
}

function BuilderForm({
  ruleId,
  rule,
  initial,
  position,
}: {
  readonly ruleId: string | null;
  readonly rule: WorkflowRule | undefined;
  readonly initial: RuleDraftState;
  readonly position: number;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const api = useAutomationApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const timeOf = useTimeOfDay();
  const options = useQuery({
    queryKey: automationKeys.options(brand.id),
    queryFn: () => api.options(brand.id),
  });
  const text = useRuleText(options.data);

  const [draft, setDraft] = useState<RuleDraftState>(initial);
  const [attempted, setAttempted] = useState(false);
  const request = requestOf(draft);
  const back = automationRoute(draft.kind === 'scheduled' ? 'time-based' : 'rules');

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: automationKeys.all(brand.id) });
  };
  const save = useTicketingAction(
    (body: NonNullable<typeof request>) =>
      ruleId === null ? api.createRule(brand.id, body) : api.updateRule(brand.id, ruleId, body),
    (body) => t(ruleId === null ? 'rules:toast.created' : 'rules:toast.saved', { name: body.name }),
    refresh,
    report,
  );

  const set = (patch: Partial<RuleDraftState>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setGroup = (index: number, next: GroupDraft | null): void => {
    setDraft((current) => ({
      ...current,
      groups:
        next === null
          ? current.groups.filter((_group, at) => at !== index)
          : current.groups.map((group, at) => (at === index ? next : group)),
    }));
  };

  const title = ruleId === null ? t('rules:builder.newTitle') : (rule?.name ?? '');

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 380px' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <MuiLink
            component={Link}
            to={back}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
          >
            <Box
              component="span"
              sx={{ display: 'inline-flex', '[dir="rtl"] &': { transform: 'scaleX(-1)' } }}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Box>
            {t(draft.kind === 'scheduled' ? 'rules:tabs.timeBased' : 'rules:tabs.rules')}
          </MuiLink>
          <Typography component="span" aria-hidden="true" sx={{ color: 'text.secondary' }}>
            /
          </Typography>
          <Typography variant="h2" component="h2" sx={{ fontSize: 20 }}>
            {title}
          </Typography>
          <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Switch
              checked={draft.enabled}
              label={t('rules:builder.ruleEnabled')}
              onChange={(enabled) => {
                set({ enabled });
              }}
            />
            <Typography variant="body2">
              {t(draft.enabled ? 'rules:builder.enabled' : 'rules:builder.disabled')}
            </Typography>
          </Box>
          {rule === undefined || rule.lastAppliedAt === null ? null : (
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
              {t('rules:builder.stats', {
                count: rule.appliedLast30Days,
                time: timeOf(rule.lastAppliedAt),
              })}
            </Typography>
          )}
        </Box>

        <Box
          component="form"
          aria-label={
            ruleId === null
              ? t('rules:builder.newTitle')
              : t('rules:builder.formLabel', { name: title })
          }
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setAttempted(true);
            if (request === null) {
              return;
            }
            save.mutate(request, {
              onSuccess: (saved) => {
                if (ruleId === null) {
                  void navigate(ruleRoute(saved.id), { replace: true });
                }
              },
            });
          }}
          sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 2fr' }, gap: 4 }}>
            <Field
              id="rule-name"
              label={`${t('rules:builder.name')} · ${t('rules:builder.required')}`}
              {...(attempted && draft.name.trim() === ''
                ? { error: t('rules:builder.nameMissing') }
                : {})}
            >
              <TextField
                id="rule-name"
                size="small"
                value={draft.name}
                onChange={(event) => {
                  set({ name: event.target.value });
                }}
                error={attempted && draft.name.trim() === ''}
                slotProps={{ htmlInput: { maxLength: RULE_NAME_MAX_LENGTH, dir: 'auto' } }}
              />
            </Field>
            <Field
              id="rule-description"
              label={`${t('rules:builder.description')} · ${t('rules:builder.optional')}`}
            >
              <TextField
                id="rule-description"
                size="small"
                value={draft.description}
                onChange={(event) => {
                  set({ description: event.target.value });
                }}
                slotProps={{ htmlInput: { maxLength: RULE_DESCRIPTION_MAX_LENGTH, dir: 'auto' } }}
              />
            </Field>
          </Box>

          <Section label={t('rules:builder.when')}>
            <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography id="rule-runs" sx={{ fontSize: 13, fontWeight: 500 }}>
                  {t('rules:builder.runs')}
                </Typography>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  value={draft.kind}
                  aria-labelledby="rule-runs"
                  onChange={(_event, kind: RuleKind | null) => {
                    if (kind !== null) {
                      set({ kind });
                    }
                  }}
                >
                  <ToggleButton value="event">{t('rules:builder.onEvent')}</ToggleButton>
                  <ToggleButton value="scheduled">{t('rules:builder.onSchedule')}</ToggleButton>
                </ToggleButtonGroup>
              </Box>
              {draft.kind === 'event' ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Typography
                    component="label"
                    htmlFor="rule-event"
                    sx={{ fontSize: 13, fontWeight: 500 }}
                  >
                    {t('rules:builder.event')}
                  </Typography>
                  <Choice
                    id="rule-event"
                    value={draft.trigger}
                    onChange={(value) => {
                      const trigger = ruleTriggerSchema.safeParse(value);
                      if (trigger.success) {
                        set({ trigger: trigger.data });
                      }
                    }}
                  >
                    {ruleTriggerSchema.options.map((trigger) => (
                      <option key={trigger} value={trigger}>
                        {text.trigger(trigger)}
                      </option>
                    ))}
                  </Choice>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Typography
                    component="label"
                    htmlFor="rule-interval"
                    sx={{ fontSize: 13, fontWeight: 500 }}
                  >
                    {t('rules:builder.interval')}
                  </Typography>
                  <Choice
                    id="rule-interval"
                    value={String(draft.intervalMinutes)}
                    onChange={(value) => {
                      const minutes = RULE_INTERVALS_MINUTES.find(
                        (candidate) => String(candidate) === value,
                      );
                      if (minutes !== undefined) {
                        set({ intervalMinutes: minutes as RuleInterval });
                      }
                    }}
                  >
                    {RULE_INTERVALS_MINUTES.map((minutes) => (
                      <option key={minutes} value={String(minutes)}>
                        {t(`rules:intervals.${String(minutes) as '15'}`)}
                      </option>
                    ))}
                  </Choice>
                </Box>
              )}
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {draft.kind === 'event'
                ? `${t(`rules:triggerHints.${draft.trigger}`)} ${t('rules:builder.order', { position })}`
                : t('rules:builder.scheduleNote')}
            </Typography>
          </Section>

          <Section label={t('rules:builder.if')}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
              <Typography variant="body2">{t('rules:builder.ticketMatches')}</Typography>
              <MatchChoice
                label={t('rules:builder.groupsMatch')}
                value={draft.match}
                all={t('rules:builder.all')}
                any={t('rules:builder.any')}
                onChange={(match) => {
                  set({ match });
                }}
              />
              <Typography variant="body2">{t('rules:builder.ofGroups')}</Typography>
            </Box>
            {draft.groups.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {t('rules:builder.noConditions')}
              </Typography>
            ) : null}
            {draft.groups.map((group, index) => {
              const n = index + 1;
              return (
                <Box key={group.key} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {index === 0 ? null : (
                    <Typography
                      variant="caption"
                      sx={{ color: 'text.secondary', textTransform: 'none' }}
                    >
                      {t(draft.match === 'all' ? 'rules:builder.and' : 'rules:builder.or')}
                    </Typography>
                  )}
                  <Box
                    component="fieldset"
                    sx={{
                      margin: 0,
                      padding: 3,
                      borderRadius: '6px',
                      border: `1px solid ${tokens['border.default']}`,
                      minWidth: 0,
                    }}
                  >
                    <Box component="legend" sx={visuallyHidden}>
                      {t('rules:builder.group', { n })}
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }} aria-hidden="true">
                        {t('rules:builder.group', { n })}
                      </Typography>
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {t('rules:builder.match')}
                      </Typography>
                      <MatchChoice
                        label={t('rules:builder.groupMatch', { n })}
                        value={group.match}
                        all={t('rules:builder.allOf')}
                        any={t('rules:builder.anyOf')}
                        onChange={(match) => {
                          setGroup(index, { ...group, match });
                        }}
                      />
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {t('rules:builder.theseConditions')}
                      </Typography>
                      <IconButton
                        size="small"
                        aria-label={t('rules:builder.removeGroup', { n })}
                        onClick={() => {
                          setGroup(index, null);
                        }}
                        sx={{ marginInlineStart: 'auto', width: 28, height: 28 }}
                      >
                        <X size={16} aria-hidden="true" />
                      </IconButton>
                    </Box>
                    {group.conditions.map((condition, at) => (
                      <ConditionRow
                        key={condition.key}
                        condition={condition}
                        options={options.data}
                        text={text}
                        onChange={(next) => {
                          setGroup(index, {
                            ...group,
                            conditions: group.conditions.map((entry, position) =>
                              position === at ? next : entry,
                            ),
                          });
                        }}
                        onRemove={() => {
                          const conditions = group.conditions.filter(
                            (_entry, position) => position !== at,
                          );
                          setGroup(
                            index,
                            conditions.length === 0 ? null : { ...group, conditions },
                          );
                        }}
                      />
                    ))}
                    <Button
                      size="small"
                      variant="text"
                      startIcon={<Plus size={16} aria-hidden="true" />}
                      onClick={() => {
                        setGroup(index, {
                          ...group,
                          conditions: [...group.conditions, newCondition()],
                        });
                      }}
                      sx={{ marginBlockStart: 1 }}
                    >
                      {t('rules:builder.addCondition')}
                    </Button>
                  </Box>
                </Box>
              );
            })}
            <Box>
              <Button
                size="small"
                variant="outlined"
                startIcon={<Plus size={16} aria-hidden="true" />}
                onClick={() => {
                  set({ groups: [...draft.groups, newGroup()] });
                }}
              >
                {t('rules:builder.addGroup')}
              </Button>
            </Box>
          </Section>

          <Section label={t('rules:builder.then')} hint={t('rules:builder.thenHint')}>
            <Box
              component="ol"
              aria-label={t('rules:builder.actions')}
              sx={{ margin: 0, padding: 0, listStyle: 'none' }}
            >
              {draft.actions.map((row, index) => (
                <ActionRow
                  key={row.key}
                  index={index}
                  action={row.action}
                  options={options.data}
                  onChange={(action) => {
                    set({
                      actions: draft.actions.map((entry, at) =>
                        at === index ? { ...entry, action } : entry,
                      ),
                    });
                  }}
                  onRemove={() => {
                    set({ actions: draft.actions.filter((_entry, at) => at !== index) });
                  }}
                  onMove={(offset) => {
                    set({ actions: moveItem(draft.actions, index, offset) });
                  }}
                />
              ))}
            </Box>
            <Box>
              <Button
                size="small"
                variant="outlined"
                startIcon={<Plus size={16} aria-hidden="true" />}
                onClick={() => {
                  set({ actions: [...draft.actions, actionDraft(newAction('add_tag'))] });
                }}
              >
                {t('rules:builder.addAction')}
              </Button>
            </Box>
          </Section>

          {attempted && request === null ? (
            <Typography role="alert" variant="body2" sx={{ color: tokens['status.danger.text'] }}>
              {t('rules:builder.incomplete')}
            </Typography>
          ) : null}

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
            <Button variant="text" component={Link} to={back}>
              {t('rules:builder.cancel')}
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {t('rules:builder.save')}
            </Button>
          </Box>
        </Box>
      </Box>

      <TestRunPanel request={request} ruleId={ruleId} options={options.data} text={text} />
    </Box>
  );
}

/** A When / If / Then card: the word in its column, the section beside it. */
function Section({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="section"
      aria-label={label}
      sx={{
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <Box>
        <Typography variant="h3" component="h3">
          {label}
        </Typography>
        {hint === undefined ? null : (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {hint}
          </Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

function MatchChoice({
  label,
  value,
  all,
  any,
  onChange,
}: {
  readonly label: string;
  readonly value: RuleMatch;
  readonly all: string;
  readonly any: string;
  readonly onChange: (match: RuleMatch) => void;
}): ReactNode {
  return (
    <Choice
      label={label}
      value={value}
      onChange={(next) => {
        onChange(next === 'any' ? 'any' : 'all');
      }}
    >
      <option value="all">{all}</option>
      <option value="any">{any}</option>
    </Choice>
  );
}
