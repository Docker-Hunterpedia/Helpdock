import {
  type Ai,
  AiNotConfiguredError,
  BudgetExceededError,
  type Classification,
  classifyInstructions,
  formatThread,
  readClassification,
  UnreadableAnswerError,
} from '@helpdock/ai';
import { type Db, type DbTransaction, jobReceipts, workflowRuns } from '@helpdock/db';
import {
  type AiClassifyPayload,
  aiClassifyJob,
  claimReceipt,
  type JobLogger,
  parseJobPayload,
} from '@helpdock/jobs';
import type { AiTriageOutcome, RuleAction } from '@helpdock/schemas';
import { type Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { AssistRepository } from '../assist/assist.repository.js';
import { threadLines } from '../assist/thread-lines.js';
import { applyTriageActions, type MoveDepartment, type RuleActionDeps } from '../rules/actions.js';
import { withSystemJob } from '../tenant/system-job.js';

/**
 * `ai.classify` (M7-07): a rule's AI triage action, after the rule's
 * transaction committed.
 *
 * ```
 * system transaction   the ticket, its thread, the brand's tags and departments
 * no transaction       complete() — redacted, budget-checked, logged as `triage.classify`
 * system transaction   claim the receipt; suggest (the Suggested fields card)
 *                      or apply (as the rule: activity, event, clocks);
 *                      write the outcome into the run's log
 * ```
 *
 * Idempotent: the receipt `ai.classify:<run>:<action>` is claimed in the
 * write's transaction, and a delivery that finds it already held asks no
 * model. A refusal — no model, a spent budget, an answer that cannot be read
 * — changes nothing, is written to the run's log as `failed`, and is not
 * retried; a provider failure is retried by BullMQ.
 */

const MAX_THREAD_CHARS = 16_000;

export interface TriageDeps {
  readonly db: Db;
  readonly ai: Pick<Ai, 'complete'>;
  readonly rules: RuleActionDeps;
  readonly log: JobLogger;
  readonly now?: () => Date;
}

const receiptKey = (payload: AiClassifyPayload): string =>
  `${aiClassifyJob.name}:${payload.runId}:${String(payload.actionIndex)}`;

/** Writes the outcome into the triage action's entry of the run's log. */
const recordOutcome = async (
  tx: DbTransaction,
  payload: AiClassifyPayload,
  triage: AiTriageOutcome,
): Promise<void> => {
  const [run] = await tx
    .select({ details: workflowRuns.details })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, payload.runId))
    .limit(1);
  const actions = run?.details.actions;
  if (!Array.isArray(actions) || actions[payload.actionIndex] === undefined) {
    return;
  }
  const next = actions.map((entry: unknown, index) =>
    index === payload.actionIndex ? { ...(entry as object), triage } : entry,
  );
  await tx
    .update(workflowRuns)
    .set({ details: { ...run?.details, actions: next } })
    .where(eq(workflowRuns.id, payload.runId));
};

const refusalOf = (error: unknown): string | null => {
  if (error instanceof BudgetExceededError) {
    return 'budget-exceeded';
  }
  if (error instanceof AiNotConfiguredError) {
    return 'not-configured';
  }
  if (error instanceof UnreadableAnswerError) {
    return 'unreadable-answer';
  }
  return null;
};

/** Only the fields the action named. */
const narrowed = (classification: Classification, fields: AiClassifyPayload['fields']) => ({
  tagIds: fields.includes('tags') ? classification.tagIds : [],
  priority: fields.includes('priority') ? classification.priority : null,
  departmentId: fields.includes('department') ? classification.departmentId : null,
});

export const runTriage = async (
  deps: TriageDeps,
  payload: AiClassifyPayload,
  jobId: string,
): Promise<AiTriageOutcome | null> => {
  const repository = new AssistRepository();
  const inBrand = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystemJob(deps.db, payload.brandId, `${aiClassifyJob.name}:${jobId}`, fn);

  const read = await inBrand(async (tx) => {
    const [done] = await tx
      .select({ key: jobReceipts.key })
      .from(jobReceipts)
      .where(eq(jobReceipts.key, receiptKey(payload)))
      .limit(1);
    const ticket = done === undefined ? await repository.ticket(tx, payload.ticketId) : undefined;
    if (ticket === undefined) {
      return null;
    }
    return {
      ticket,
      lines: threadLines(await repository.thread(tx, payload.ticketId), { publicOnly: false }),
      tags: await repository.tags(tx),
      departments: await repository.departments(tx),
    };
  });
  if (read === null) {
    return null;
  }

  let classification: ReturnType<typeof narrowed>;
  let callId: string;
  try {
    const thread = formatThread(read.lines);
    const result = await deps.ai.complete({
      brandId: payload.brandId,
      ticketId: payload.ticketId,
      feature: 'triage.classify',
      instructions: classifyInstructions({ ...read, fields: payload.fields }),
      messages: [
        {
          role: 'user',
          text: `Ticket: ${read.ticket.subject}\n\n${thread.slice(Math.max(0, thread.length - MAX_THREAD_CHARS))}`,
        },
      ],
    });
    callId = result.callId;
    classification = narrowed(
      readClassification(result.text, {
        tagIds: read.tags.map((tag) => tag.id),
        departmentIds: read.departments.map((department) => department.id),
      }),
      payload.fields,
    );
  } catch (error) {
    const reason = refusalOf(error);
    if (reason === null) {
      throw error;
    }
    const failed: AiTriageOutcome = { status: 'failed', reason };
    await inBrand(async (tx) => {
      if (await claimReceipt(tx, receiptKey(payload))) {
        await recordOutcome(tx, payload, failed);
      }
    });
    return failed;
  }

  return inBrand(async (tx) => {
    if (!(await claimReceipt(tx, receiptKey(payload)))) {
      return null;
    }
    const outcome =
      payload.mode === 'suggest'
        ? await suggest(tx, repository, payload, classification, read.ticket.departmentId, callId)
        : await apply(deps, tx, payload, classification, callId);
    await recordOutcome(tx, payload, outcome);
    return outcome;
  });
};

const isEmpty = (fields: ReturnType<typeof narrowed>): boolean =>
  fields.tagIds.length === 0 && fields.priority === null && fields.departmentId === null;

const suggest = async (
  tx: DbTransaction,
  repository: AssistRepository,
  payload: AiClassifyPayload,
  classification: ReturnType<typeof narrowed>,
  currentDepartmentId: string,
  callId: string,
): Promise<AiTriageOutcome> => {
  const departmentId =
    classification.departmentId === currentDepartmentId ? null : classification.departmentId;
  const fields = { ...classification, departmentId };
  if (isEmpty(fields)) {
    return { status: 'nothing', callId };
  }
  await repository.saveSuggestions(tx, {
    brandId: payload.brandId,
    ticketId: payload.ticketId,
    departmentId: currentDepartmentId,
    tagIds: fields.tagIds,
    priority: fields.priority,
    suggestedDepartmentId: fields.departmentId,
    source: `rule:${payload.ruleId}`,
    aiCallId: callId,
  });
  return {
    status: 'suggested',
    callId,
    ...(fields.tagIds.length === 0 ? {} : { tagIds: [...fields.tagIds] }),
    ...(fields.priority === null ? {} : { priority: fields.priority }),
    ...(fields.departmentId === null ? {} : { departmentId: fields.departmentId }),
  };
};

const apply = async (
  deps: TriageDeps,
  tx: DbTransaction,
  payload: AiClassifyPayload,
  classification: ReturnType<typeof narrowed>,
  callId: string,
): Promise<AiTriageOutcome> => {
  const target = await deps.rules.tickets.findTicket(tx, payload.ticketId);
  if (target === undefined) {
    return { status: 'nothing', callId };
  }
  const actions: (RuleAction | MoveDepartment)[] = [
    ...(classification.priority === null
      ? []
      : [{ type: 'set_priority' as const, priority: classification.priority }]),
    ...classification.tagIds.map((tagId) => ({ type: 'add_tag' as const, tagId })),
    // Last, so the tags and priority are written before the ticket moves away.
    ...(classification.departmentId === null
      ? []
      : [{ type: 'move_department' as const, departmentId: classification.departmentId }]),
  ];
  const outcomes = await applyTriageActions(
    deps.rules,
    {
      tx,
      brandId: payload.brandId,
      ruleId: payload.ruleId,
      runId: payload.runId,
      chain: payload.chain,
      now: (deps.now ?? (() => new Date()))(),
    },
    target,
    actions,
  );
  const changed = outcomes.filter((outcome) => outcome.effect === 'changed');
  if (changed.length === 0) {
    return { status: 'nothing', callId };
  }
  const tagIds = changed.flatMap(({ action }) => (action.type === 'add_tag' ? [action.tagId] : []));
  const priority = changed.find(({ action }) => action.type === 'set_priority');
  const moved = changed.find(({ action }) => action.type === 'move_department');
  return {
    status: 'applied',
    callId,
    ...(tagIds.length === 0 ? {} : { tagIds }),
    ...(priority?.action.type === 'set_priority' ? { priority: priority.action.priority } : {}),
    ...(moved?.action.type === 'move_department'
      ? { departmentId: moved.action.departmentId }
      : {}),
  };
};

/** The `ai` queue's share for triage; null for any other job. */
export const createTriageProcessor =
  (deps: TriageDeps) =>
  (job: Job): Promise<void> | null => {
    if (job.name !== aiClassifyJob.name) {
      return null;
    }
    let payload: AiClassifyPayload;
    try {
      payload = parseJobPayload(aiClassifyJob, job.data);
    } catch (error) {
      throw new UnrecoverableError(error instanceof Error ? error.message : 'invalid payload');
    }
    return runTriage(deps, payload, job.id ?? job.name).then((outcome) => {
      deps.log.info(
        {
          job: job.name,
          brandId: payload.brandId,
          ticketId: payload.ticketId,
          outcome: outcome?.status,
        },
        'ai triage finished',
      );
    });
  };
