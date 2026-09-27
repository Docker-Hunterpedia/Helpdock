import type { DbTransaction, WorkflowRuleRow } from '@helpdock/db';
import type { JobLogger } from '@helpdock/jobs';
import {
  type ActionOutcome,
  type RuleAction,
  type RuleConditions,
  ruleActionSchema,
  ruleConditionsSchema,
  ruleDurationMinutes,
} from '@helpdock/schemas';
import { z } from 'zod';
import { applyRuleActions, type RuleActionDeps } from './actions.js';
import { evaluateConditions, firstFailedGroup } from './conditions.js';
import type { BusinessHoursProbe } from './ports.js';
import { loadTicketFacts, type TicketFacts } from './ticket-facts.js';
import { guardRun } from './triggers.js';

/**
 * The engine of M3-03 and M3-04: for one ticket and one event, or for one
 * scheduled rule and the tickets it matches, decide which rules run, run them,
 * and log every decision.
 *
 * **Each rule's actions run in a savepoint.** A rule that throws — a bug, a
 * constraint it trips — rolls back its own writes, is logged `failed`, and the
 * rules after it still run: one broken rule must not stop a brand's
 * automation, and must not be retried forever with the job either.
 *
 * **Every rule for one event is judged against the ticket as the event left
 * it**, and the rules that match act in list order, each on the ticket as the
 * one before left it — so where two rules set the same field, the later one
 * wins. What a rule's actions change is a new event, with the rule in its
 * chain, and the rules it sets off are judged then, one level deeper. Judging
 * them again inside this event would run them twice for one change, and hide
 * the chain the depth guard counts.
 */

export interface RulesEngineDeps extends RuleActionDeps {
  readonly businessHours: BusinessHoursProbe;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

/** How many tickets one scheduled rule looks at per tick. The rest wait for the next. */
export const SCHEDULED_BATCH = 200;

interface ParsedRule {
  readonly conditions: RuleConditions;
  readonly actions: RuleAction[];
}

const parsedRuleSchema = z.object({
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema),
});

/** A stored rule, validated on the way out as it was on the way in. */
const parseRule = (rule: WorkflowRuleRow): ParsedRule | null => {
  const result = parsedRuleSchema.safeParse({
    conditions: rule.conditions,
    actions: rule.actions,
  });
  return result.success ? result.data : null;
};

const usesBusinessHours = (conditions: RuleConditions): boolean =>
  conditions.groups.some((group) =>
    group.conditions.some((condition) => condition.field === 'business_hours'),
  );

const clock = (deps: RulesEngineDeps): Date => deps.now?.() ?? new Date();

const withinBusinessHours = (
  deps: RulesEngineDeps,
  tx: DbTransaction,
  brandId: string,
  facts: TicketFacts,
  conditions: RuleConditions,
  now: Date,
): Promise<boolean> =>
  usesBusinessHours(conditions)
    ? deps.businessHours.isOpen(tx, { brandId, departmentId: facts.departmentId, at: now })
    : Promise.resolve(true);

/**
 * Runs the actions in a savepoint and reports what they did, or `null` when
 * they threw — in which case nothing they wrote survives.
 */
const applyInSavepoint = async (
  deps: RulesEngineDeps,
  tx: DbTransaction,
  run: {
    readonly brandId: string;
    readonly ticketId: string;
    readonly rule: WorkflowRuleRow;
    readonly chain: readonly string[];
    readonly now: Date;
  },
  actions: readonly RuleAction[],
  beforeActions?: (savepoint: DbTransaction) => Promise<boolean>,
): Promise<ActionOutcome[] | 'skipped' | null> => {
  try {
    return await tx.transaction(async (savepoint) => {
      if (beforeActions !== undefined && !(await beforeActions(savepoint))) {
        return 'skipped' as const;
      }
      const target = await deps.tickets.findTicket(savepoint, run.ticketId);
      if (target === undefined) {
        return [];
      }
      return applyRuleActions(
        deps,
        {
          tx: savepoint,
          brandId: run.brandId,
          ruleId: run.rule.id,
          chain: [...run.chain, run.rule.id],
          now: run.now,
        },
        target,
        actions,
      );
    });
  } catch (error) {
    deps.log.error(
      { brandId: run.brandId, ruleId: run.rule.id, err: error },
      'a workflow rule failed; its changes were rolled back',
    );
    return null;
  }
};

export interface EventEvaluation {
  readonly brandId: string;
  readonly ticketId: string;
  readonly triggers: readonly string[];
  /** The rules before this event in its chain, oldest first. */
  readonly chain: readonly string[];
}

/** What happened to each rule the event reached, in order. The log holds the same. */
export type RunVerdict = 'applied' | 'skipped' | 'stopped' | 'failed';

export const evaluateEventRules = async (
  deps: RulesEngineDeps,
  tx: DbTransaction,
  { brandId, ticketId, triggers, chain }: EventEvaluation,
): Promise<{ ruleId: string; verdict: RunVerdict }[]> => {
  const rules = await deps.rules.eventRules(tx, triggers);
  const verdicts: { ruleId: string; verdict: RunVerdict }[] = [];
  const now = clock(deps);

  const ticket = rules.length === 0 ? undefined : await loadTicketFacts(tx, ticketId);
  if (ticket === undefined || ticket.inert) {
    return verdicts;
  }

  for (const rule of rules) {

    const base = {
      brandId,
      departmentId: ticket.departmentId,
      ruleId: rule.id,
      ruleName: rule.name,
      ticketId,
      trigger: rule.trigger ?? 'ticket_updated',
      depth: chain.length + 1,
      chain: [...chain],
    };

    const parsed = parseRule(rule);
    if (parsed === null) {
      await deps.rules.insertRun(tx, { ...base, result: 'failed', details: { error: 'invalid' } });
      verdicts.push({ ruleId: rule.id, verdict: 'failed' });
      continue;
    }

    const outcome = evaluateConditions(parsed.conditions, ticket, {
      now,
      withinBusinessHours: await withinBusinessHours(
        deps,
        tx,
        brandId,
        ticket,
        parsed.conditions,
        now,
      ),
      includeText: false,
    });
    if (!outcome.matched) {
      await deps.rules.insertRun(tx, {
        ...base,
        result: 'skipped',
        details: { failedGroup: firstFailedGroup(outcome) },
      });
      verdicts.push({ ruleId: rule.id, verdict: 'skipped' });
      continue;
    }

    const guard = guardRun(rule.id, chain);
    if (guard.kind === 'stop') {
      await deps.rules.insertRun(tx, { ...base, result: 'stopped', stopReason: guard.reason });
      deps.log.warn(
        { brandId, ticketId, ruleId: rule.id, reason: guard.reason, depth: guard.depth },
        'the rules depth guard stopped a run',
      );
      verdicts.push({ ruleId: rule.id, verdict: 'stopped' });
      continue;
    }

    const outcomes = await applyInSavepoint(
      deps,
      tx,
      { brandId, ticketId, rule, chain, now },
      parsed.actions,
    );
    const verdict: RunVerdict = outcomes === null ? 'failed' : 'applied';
    await deps.rules.insertRun(tx, {
      ...base,
      result: verdict,
      details:
        outcomes === null || outcomes === 'skipped' ? { error: 'internal' } : { actions: outcomes },
    });
    verdicts.push({ ruleId: rule.id, verdict });
  }

  return verdicts;
};

/**
 * What of a scheduled rule's conditions can be asked in SQL, so the scan
 * reads the tickets that can match rather than the oldest two hundred of the
 * brand. Only a condition every match must satisfy narrows: one inside an
 * `all` group that the rule requires.
 */
export const narrowingOf = (
  conditions: RuleConditions,
  now: Date,
): { statusIds?: string[]; changedBefore?: Date } => {
  const required =
    conditions.match === 'all' || conditions.groups.length === 1
      ? conditions.groups.filter((group) => group.match === 'all' || group.conditions.length === 1)
      : [];

  let statusIds: string[] | undefined;
  let changedBefore: Date | undefined;

  for (const condition of required.flatMap((group) => group.conditions)) {
    if (
      condition.field === 'status' &&
      (condition.operator === 'is' || condition.operator === 'any_of')
    ) {
      statusIds =
        statusIds === undefined
          ? [...condition.values]
          : statusIds.filter((id) => condition.values.includes(id));
    }
    if (
      condition.field === 'time_in_status' &&
      condition.operator === 'more_than' &&
      condition.duration !== undefined
    ) {
      const before = new Date(now.getTime() - ruleDurationMinutes(condition.duration) * 60_000);
      changedBefore =
        changedBefore === undefined || before < changedBefore ? before : changedBefore;
    }
  }

  return {
    ...(statusIds === undefined ? {} : { statusIds }),
    ...(changedBefore === undefined ? {} : { changedBefore }),
  };
};

/**
 * One tick of M3-04 for one brand: every scheduled rule whose interval has
 * passed, over the tickets it matches. A ticket is acted on once per match —
 * per stay in the status it matched in — which the run's `match_key` and its
 * unique index enforce; a match that is already claimed is not logged again.
 * Only applied and failed runs are logged: a tick that finds nothing to do
 * would otherwise fill the log with the same skips every five minutes.
 */
export const runScheduledRules = async (
  deps: RulesEngineDeps,
  tx: DbTransaction,
  { brandId }: { readonly brandId: string },
): Promise<{ applied: number; failed: number }> => {
  const now = clock(deps);
  const rules = await deps.rules.dueScheduledRules(tx, now);
  let applied = 0;
  let failed = 0;

  for (const rule of rules) {
    await deps.rules.markScheduledRun(tx, rule.id, now);
    const parsed = parseRule(rule);
    if (parsed === null) {
      continue;
    }

    const candidates = await deps.rules.scheduledCandidates(tx, {
      ...narrowingOf(parsed.conditions, now),
      limit: SCHEDULED_BATCH,
    });

    for (const ticketId of candidates) {
      const ticket = await loadTicketFacts(tx, ticketId);
      if (ticket === undefined || ticket.inert) {
        continue;
      }

      const outcome = evaluateConditions(parsed.conditions, ticket, {
        now,
        withinBusinessHours: await withinBusinessHours(
          deps,
          tx,
          brandId,
          ticket,
          parsed.conditions,
          now,
        ),
        includeText: false,
      });
      if (!outcome.matched) {
        continue;
      }

      const base = {
        brandId,
        departmentId: ticket.departmentId,
        ruleId: rule.id,
        ruleName: rule.name,
        ticketId,
        trigger: 'schedule',
        depth: 1,
        chain: [],
      };
      let runId: string | undefined;
      const outcomes = await applyInSavepoint(
        deps,
        tx,
        { brandId, ticketId, rule, chain: [], now },
        parsed.actions,
        async (savepoint) => {
          runId = await deps.rules.claimMatch(savepoint, {
            ...base,
            result: 'applied',
            matchKey: ticket.statusChangedAt.toISOString(),
          });
          return runId !== undefined;
        },
      );

      if (outcomes === 'skipped') {
        continue;
      }
      if (outcomes === null || runId === undefined) {
        // Unclaimed, so the next tick tries this ticket again.
        await deps.rules.insertRun(tx, {
          ...base,
          result: 'failed',
          details: { error: 'internal' },
        });
        failed += 1;
        continue;
      }

      await deps.rules.setRunOutcome(tx, runId, {
        result: 'applied',
        details: { actions: outcomes },
      });
      applied += 1;
    }
  }

  return { applied, failed };
};
