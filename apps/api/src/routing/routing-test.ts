import type { DbTransaction } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';
import {
  evaluateConditions,
  type RoutingDepartmentRef,
  type RoutingTestAssignment,
  type RoutingTestContact,
  type RoutingTestInput,
  type RoutingTestResult,
  type RoutingTestRule,
  type RoutingTestSla,
  type RoutingTestTicket,
  type RuleConditions,
  ruleActionSchema,
  ruleConditionsSchema,
  type TicketChannel,
} from '@helpdock/schemas';
import { z } from 'zod';
import type { AssignmentRepository } from '../assignment/assignment.repository.js';
import type { PresenceReader } from '../assignment/auto-assign.js';
import { eligibleCandidates, pickAssignee } from '../assignment/rotation.js';
import { subjectOf } from '../channels/inbound/conversation-router.js';
import type { BusinessHoursProbe } from '../rules/ports.js';
import type { RulesRepository } from '../rules/rules.repository.js';
import { followOnsOf, previewActions } from '../rules/test-run.js';
import type { TicketFacts } from '../rules/ticket-facts.js';
import { startClock } from '../sla/clock.js';
import { matchPolicy } from '../sla/policy-match.js';
import type { SlaService } from '../sla/sla.service.js';
import type { SnoozeResolver } from '../tickets/snooze/snooze-calendar.js';
import { subjectFor as formSubjectFor } from '../web-form/web-form-ticket.writer.js';
import { subjectFrom } from '../widget/plain-text.js';
import type { ResolvedEntry } from './entry-points.js';
import type { RoutingRepository } from './routing.repository.js';
import { contactOf, isAutomated, isBlocked, senderIdentity } from './sender-check.js';

/**
 * Test routing (M14-09): a sample message walked through the code a real one
 * takes, in the order it takes it, with every write left out.
 *
 * ```
 * door → department → sender check → contact → rules → triage → SLA → assignment
 * ```
 *
 * Read-only by construction: it calls the reads of the real steps (the block
 * list without its counter, the rules' own evaluator and action preview, the
 * SLA clock's due time, the rotation's pick without its lock or its
 * "last picked" stamp) and never the writes. The caller also runs it inside
 * {@link withDryRun}, which the database enforces.
 */

export interface RoutingTestDeps {
  readonly repository: RoutingRepository;
  readonly rules: RulesRepository;
  readonly assignment: AssignmentRepository;
  readonly businessHours: BusinessHoursProbe;
  readonly sla: Pick<SlaService, 'brandContext'>;
  readonly presence: PresenceReader;
  readonly snooze: SnoozeResolver;
  readonly now?: () => Date;
}

export interface RoutingTestScope {
  readonly brandId: string;
  /** Whether the reader's role reaches this department. */
  readonly reaches: (departmentId: string) => boolean;
}

/** Stands in for a ticket that does not exist; nothing here looks one up by it. */
const NO_TICKET = '00000000-0000-0000-0000-000000000000';

const storedRuleSchema = z.object({
  conditions: ruleConditionsSchema,
  actions: z.array(ruleActionSchema),
});

/**
 * The ticket's subject as the door's own path derives it: an email's, with the
 * "(no subject)" fallback; the first line of a web form's message when it asks
 * for no subject; the first line of a chat, Telegram or Meta message; and the
 * API's, as given. The functions are the channels' own.
 */
const subjectFor = (entry: ResolvedEntry, request: RoutingTestInput, locale: Locale): string => {
  switch (entry.entry) {
    case 'mailbox':
      return subjectOf(request.subject, locale);
    case 'web_form':
      return formSubjectFor(
        { subject: request.subject === '' ? null : request.subject, message: request.message },
        locale,
      );
    case 'api_key':
      return request.subject;
    default:
      return subjectFrom(request.message, locale);
  }
};

const localeOf = async (
  deps: RoutingTestDeps,
  tx: DbTransaction,
  brandId: string,
  requested: RoutingTestInput['language'],
  contactLocale: Locale | null,
): Promise<Locale> => {
  if (requested === 'en' || requested === 'ar') {
    return requested;
  }

  return contactLocale ?? deps.rules.brandLocale(tx, brandId);
};

const usesBusinessHours = (conditions: RuleConditions): boolean =>
  conditions.groups.some((group) =>
    group.conditions.some((condition) => condition.field === 'business_hours'),
  );

interface Walk {
  readonly deps: RoutingTestDeps;
  readonly tx: DbTransaction;
  readonly scope: RoutingTestScope;
  readonly now: Date;
}

/** Step 3: the rules, in order. Conditions are judged on the ticket as it arrived (engine.ts). */
const walkRules = async (
  walk: Walk,
  initial: TicketFacts,
): Promise<{ rules: RoutingTestRule[]; facts: TicketFacts; triageQueued: boolean }> => {
  const { deps, tx, scope, now } = walk;
  const stored = (await deps.rules.eventRules(tx, ['ticket_created'])).flatMap((rule) => {
    const parsed = storedRuleSchema.safeParse(rule);
    return parsed.success ? [{ rule, ...parsed.data }] : [];
  });
  const openNow = await deps.businessHours.isOpen(tx, {
    brandId: scope.brandId,
    departmentId: initial.departmentId,
    at: now,
  });
  const context = { now, withinBusinessHours: openNow, includeText: true };

  let facts = initial;
  let triageQueued = false;
  const rules: RoutingTestRule[] = [];

  for (const { rule, conditions, actions } of stored) {
    const outcome = evaluateConditions(conditions, initial, {
      ...context,
      withinBusinessHours: usesBusinessHours(conditions) ? openNow : true,
    });
    if (!outcome.matched) {
      rules.push({
        ruleId: rule.id,
        name: rule.name,
        matched: false,
        groups: [...outcome.groups],
        actions: [],
        followOns: [],
      });
      continue;
    }

    const preview = await previewActions(tx, scope.brandId, deps, facts, actions);
    facts = preview.simulation.facts;
    triageQueued ||= preview.outcomes.some((entry) => entry.triage?.status === 'queued');
    rules.push({
      ruleId: rule.id,
      name: rule.name,
      matched: true,
      groups: [...outcome.groups],
      actions: preview.outcomes,
      followOns: await followOnsOf(tx, deps, preview.simulation, rule.id, context),
    });
  }

  return { rules, facts, triageQueued };
};

/** Step 5: the policy that would apply and when its first-response clock would fall due. */
const slaOf = async (walk: Walk, facts: TicketFacts): Promise<RoutingTestSla> => {
  const { deps, tx, scope, now } = walk;
  const status = await deps.rules.status(tx, facts.statusId);
  if (status?.systemState === 'closed') {
    return { policy: null, firstResponseDueAt: null };
  }

  const brand = await deps.sla.brandContext(tx, scope.brandId);
  const policy = matchPolicy(brand.policies, {
    departmentId: facts.departmentId,
    priority: facts.priority,
  });
  if (policy === null) {
    return { policy: null, firstResponseDueAt: null };
  }

  const clock = startClock(
    {
      kind: 'first_response',
      cycle: 0,
      policyId: policy.id,
      targetMinutes: policy.targets[facts.priority].firstResponseMinutes,
      timeMode: policy.timeMode,
    },
    brand.calendarFor(policy.timeMode, facts.departmentId),
    now,
  );

  return {
    policy: { id: policy.id, name: policy.name },
    firstResponseDueAt: clock.dueAt?.toISOString() ?? null,
  };
};

/**
 * Step 6: who the rotation would pick now. The pick is `pickAssignee`, the
 * function the worker calls, over the same reads; what the worker does around
 * it (the brand-wide advisory lock, the "last picked" stamp, the assignment
 * itself) is left out.
 */
const assignmentOf = async (
  walk: Walk,
  initial: TicketFacts,
  facts: TicketFacts,
): Promise<RoutingTestAssignment | null> => {
  const { deps, tx, scope } = walk;
  const status = await deps.rules.status(tx, facts.statusId);
  if (status === undefined || status.systemState === 'closed') {
    return null;
  }
  if (!scope.reaches(facts.departmentId)) {
    return { kind: 'out_of_scope' };
  }
  if (facts.assigneeId !== null && initial.assigneeId === null) {
    const member = await deps.assignment.member(tx, scope.brandId, facts.assigneeId);
    return member === undefined
      ? null
      : { kind: 'rule', assignee: { id: member.userId, name: member.name } };
  }

  const department = await deps.assignment.department(tx, facts.departmentId);
  if (department === undefined) {
    return null;
  }
  if (department.assignmentMode === 'manual') {
    return { kind: 'manual' };
  }

  const mode = department.assignmentMode;
  const [candidates, online, openCounts] = await Promise.all([
    deps.assignment.candidates(tx, scope.brandId, department.id),
    deps.presence.online(scope.brandId),
    deps.assignment.openCounts(tx, department.id),
  ]);
  const input = {
    departmentId: department.id,
    mode,
    loadCap: department.loadCap,
    candidates,
    online,
    openCounts,
    ticketTagIds: facts.tagIds,
  };
  const picked = pickAssignee(input);
  const person = candidates.find((candidate) => candidate.userId === picked);
  if (picked !== null && person !== undefined) {
    return { kind: 'picked', mode, assignee: { id: person.userId, name: person.name } };
  }

  const everyoneOnline = new Set(candidates.map((candidate) => candidate.userId));
  const couldBePicked = eligibleCandidates({ ...input, online: everyoneOnline }).length > 0;

  return { kind: couldBePicked ? 'nobody_online' : 'nobody_eligible', mode };
};

const ticketOf = async (
  walk: Walk,
  facts: TicketFacts,
  departments: ReadonlyMap<string, RoutingDepartmentRef>,
): Promise<RoutingTestTicket | null> => {
  const { deps, tx } = walk;
  const department = departments.get(facts.departmentId);
  if (department === undefined) {
    return null;
  }
  const team = facts.teamId === null ? undefined : await deps.repository.teamName(tx, facts.teamId);

  return {
    department,
    team: team ?? null,
    priority: facts.priority,
    tagNames: await deps.repository.tagNames(tx, facts.tagIds),
  };
};

export const walkRouting = async (
  deps: RoutingTestDeps,
  tx: DbTransaction,
  scope: RoutingTestScope,
  request: RoutingTestInput,
  entry: ResolvedEntry & { readonly departmentId: string },
): Promise<RoutingTestResult | undefined> => {
  const now = deps.now?.() ?? new Date();
  const walk: Walk = { deps, tx, scope, now };
  const identity = senderIdentity(entry, request.from);
  const departments = await deps.repository.departments(tx, scope.brandId, [entry.departmentId]);
  const department = departments.get(entry.departmentId);
  if (department === undefined) {
    return undefined;
  }
  const arrival = {
    entry: entry.entry,
    label: entry.label,
    channel: entry.channel,
    department,
    reason: entry.reason,
  };
  const nothing = {
    contact: null,
    rules: [],
    ticket: null,
    triage: null,
    sla: null,
    assignment: null,
  };

  if (isAutomated(entry, identity)) {
    return { entry: arrival, verdict: 'automated', ...nothing };
  }
  if (await isBlocked(tx, scope.brandId, entry, identity)) {
    return { entry: arrival, verdict: 'blocked', ...nothing };
  }

  const found = await contactOf(deps.repository, tx, scope.brandId, identity);
  const contact: RoutingTestContact =
    found === undefined
      ? { kind: 'new', name: request.fromName === '' ? null : request.fromName }
      : { kind: 'matched', name: found.name, matchedBy: identity.kind };
  const locale = await localeOf(deps, tx, scope.brandId, request.language, found?.locale ?? null);
  const statusId = await deps.repository.defaultStatusId(tx);
  /* c8 ignore next 3 -- every brand is seeded with its statuses. */
  if (statusId === undefined) {
    throw new Error('This brand has no default status');
  }

  const initial: TicketFacts = {
    id: NO_TICKET,
    reference: '',
    subject: subjectFor(entry, request, locale),
    body: request.message,
    channel: entry.channel as TicketChannel,
    departmentId: entry.departmentId,
    teamId: null,
    assigneeId: null,
    priority: 'medium',
    statusId,
    statusChangedAt: now,
    tagIds: [],
    contactId: found?.id ?? null,
    contactEmails:
      found?.emails ??
      (identity.kind === 'email' && identity.value !== null ? [identity.value] : []),
    contactLocale: found?.locale ?? null,
    accountId: found?.accountId ?? null,
    custom: {},
    // The sample is a message to this entry point, so the address it names is the mailbox's own.
    mailboxId: entry.entry === 'mailbox' ? entry.entryId : null,
    toAddress: entry.entry === 'mailbox' ? (entry.label?.toLowerCase() ?? null) : null,
    inert: false,
  };

  const { rules, facts, triageQueued } = await walkRules(walk, initial);
  const finalDepartments =
    facts.departmentId === entry.departmentId
      ? departments
      : await deps.repository.departments(tx, scope.brandId, [facts.departmentId]);

  return {
    entry: arrival,
    verdict: 'ticket',
    contact,
    rules,
    ticket: await ticketOf(walk, facts, finalDepartments),
    triage: triageQueued ? 'queued' : 'not_queued',
    sla: await slaOf(walk, facts),
    assignment: await assignmentOf(walk, initial, facts),
  };
};
