import {
  brands,
  contacts,
  type DbTransaction,
  departments,
  type NewWorkflowRuleRow,
  type NewWorkflowRunRow,
  type TicketStatus as TicketStatusRow,
  tags,
  teamMembers,
  teams,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  type WorkflowRuleRow,
  workflowRules,
  workflowRuns,
} from '@helpdock/db';
import type { RuleKind, RuleRunResult, RuleTestTicket } from '@helpdock/schemas';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  max,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { TicketFacts } from './ticket-facts.js';

/**
 * Every statement M3-03 and M3-04 run, in one stateless class: the api's
 * builder screens and the worker's engine read the same rows, and every method
 * takes the caller's transaction, so the tenant context is always the caller's.
 */

/** A rule row with what the list shows beside it. */
export interface RuleWithStats {
  readonly rule: WorkflowRuleRow;
  readonly lastAppliedAt: Date | null;
  readonly appliedLast30Days: number;
}

export interface RunRow {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly ticketId: string;
  readonly ticketReference: string;
  readonly trigger: string;
  readonly result: RuleRunResult;
  readonly stopReason: string | null;
  readonly depth: number;
  readonly chain: string[];
  readonly details: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface RunFilter {
  readonly result?: RuleRunResult | undefined;
  /** A ticket number, from a reference such as `HD-1042`. */
  readonly ticketNumber?: number | undefined;
  /** A fragment of a rule's name. */
  readonly ruleName?: string | undefined;
  readonly ruleId?: string | undefined;
  readonly limit: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** A scheduled rule is due one minute early, so a 15-minute rule on 5-minute ticks runs every third one. */
const SCHEDULE_SLACK_MINUTES = 1;

export class RulesRepository {
  // ------------------------------------------------------------------ rules

  async list(tx: DbTransaction, kind?: RuleKind): Promise<RuleWithStats[]> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS);
    const stats = tx
      .select({
        ruleId: workflowRuns.ruleId,
        lastAppliedAt: max(workflowRuns.createdAt).as('last_applied_at'),
        applied: count().as('applied'),
      })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.result, 'applied'), gte(workflowRuns.createdAt, since)))
      .groupBy(workflowRuns.ruleId)
      .as('stats');

    const rows = await tx
      .select({ rule: workflowRules, lastAppliedAt: stats.lastAppliedAt, applied: stats.applied })
      .from(workflowRules)
      .leftJoin(stats, eq(stats.ruleId, workflowRules.id))
      .where(kind === undefined ? undefined : eq(workflowRules.kind, kind))
      .orderBy(asc(workflowRules.kind), asc(workflowRules.position), asc(workflowRules.id));

    return rows.map((row) => ({
      rule: row.rule,
      lastAppliedAt: row.lastAppliedAt ?? null,
      appliedLast30Days: Number(row.applied ?? 0),
    }));
  }

  async find(tx: DbTransaction, ruleId: string): Promise<WorkflowRuleRow | undefined> {
    const [row] = await tx
      .select()
      .from(workflowRules)
      .where(eq(workflowRules.id, ruleId))
      .limit(1);
    return row;
  }

  async countAll(tx: DbTransaction): Promise<number> {
    const [row] = await tx.select({ total: count() }).from(workflowRules);
    return row?.total ?? 0;
  }

  async nextPosition(tx: DbTransaction, kind: RuleKind): Promise<number> {
    const [row] = await tx
      .select({ last: max(workflowRules.position) })
      .from(workflowRules)
      .where(eq(workflowRules.kind, kind));
    return (row?.last ?? 0) + 1;
  }

  async insert(tx: DbTransaction, values: NewWorkflowRuleRow): Promise<WorkflowRuleRow> {
    const [row] = await tx.insert(workflowRules).values(values).returning();
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The rule insert returned no row');
    }
    return row;
  }

  async update(
    tx: DbTransaction,
    ruleId: string,
    values: Partial<NewWorkflowRuleRow>,
  ): Promise<WorkflowRuleRow | undefined> {
    const [row] = await tx
      .update(workflowRules)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(workflowRules.id, ruleId))
      .returning();
    return row;
  }

  async remove(tx: DbTransaction, ruleId: string): Promise<boolean> {
    const rows = await tx
      .delete(workflowRules)
      .where(eq(workflowRules.id, ruleId))
      .returning({ id: workflowRules.id });
    return rows.length === 1;
  }

  async idsOfKind(tx: DbTransaction, kind: RuleKind): Promise<string[]> {
    const rows = await tx
      .select({ id: workflowRules.id })
      .from(workflowRules)
      .where(eq(workflowRules.kind, kind));
    return rows.map((row) => row.id);
  }

  async setPositions(tx: DbTransaction, ruleIds: readonly string[]): Promise<void> {
    for (const [index, id] of ruleIds.entries()) {
      await tx
        .update(workflowRules)
        .set({ position: index + 1 })
        .where(eq(workflowRules.id, id));
    }
  }

  async names(tx: DbTransaction, ruleIds: readonly string[]): Promise<Map<string, string>> {
    if (ruleIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({ id: workflowRules.id, name: workflowRules.name })
      .from(workflowRules)
      .where(inArray(workflowRules.id, [...ruleIds]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  // ------------------------------------------------------------- the engine

  /** The enabled event rules started by any of `triggers`, in the order they run. */
  async eventRules(tx: DbTransaction, triggers: readonly string[]): Promise<WorkflowRuleRow[]> {
    if (triggers.length === 0) {
      return [];
    }
    return tx
      .select()
      .from(workflowRules)
      .where(
        and(
          eq(workflowRules.kind, 'event'),
          eq(workflowRules.enabled, true),
          inArray(workflowRules.trigger, [...triggers]),
        ),
      )
      .orderBy(asc(workflowRules.position), asc(workflowRules.id));
  }

  /** Enabled scheduled rules whose interval has passed since they last ran. */
  async dueScheduledRules(tx: DbTransaction, now: Date): Promise<WorkflowRuleRow[]> {
    return tx
      .select()
      .from(workflowRules)
      .where(
        and(
          eq(workflowRules.kind, 'scheduled'),
          eq(workflowRules.enabled, true),
          or(
            isNull(workflowRules.lastScheduledRunAt),
            lte(
              workflowRules.lastScheduledRunAt,
              sql`${now.toISOString()}::timestamptz - make_interval(mins => ${workflowRules.intervalMinutes} - ${SCHEDULE_SLACK_MINUTES})`,
            ),
          ),
        ),
      )
      .orderBy(asc(workflowRules.position), asc(workflowRules.id));
  }

  async markScheduledRun(tx: DbTransaction, ruleId: string, at: Date): Promise<void> {
    await tx
      .update(workflowRules)
      .set({ lastScheduledRunAt: at })
      .where(eq(workflowRules.id, ruleId));
  }

  /**
   * Tickets a scheduled rule might match: live ones, oldest in their status
   * first, narrowed by what the rule's conditions pin down in SQL. The
   * conditions are then evaluated in full over each candidate.
   */
  async scheduledCandidates(
    tx: DbTransaction,
    options: {
      readonly statusIds?: readonly string[] | undefined;
      readonly changedBefore?: Date | undefined;
      readonly limit: number;
    },
  ): Promise<string[]> {
    const filters: (SQL | undefined)[] = [
      isNull(tickets.deletedAt),
      isNull(tickets.mergedIntoId),
      eq(ticketStatuses.isSpam, false),
      // A rule that does not name its statuses is about live tickets: scanning
      // every closed ticket of the brand on every tick would find the same
      // years of history each time.
      options.statusIds === undefined
        ? ne(ticketStatuses.systemState, 'closed')
        : inArray(tickets.statusId, [...options.statusIds]),
      options.changedBefore === undefined
        ? undefined
        : lte(tickets.statusChangedAt, options.changedBefore),
    ];

    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, tickets.statusId))
      .where(and(...filters))
      .orderBy(asc(tickets.statusChangedAt), asc(tickets.id))
      .limit(options.limit);

    return rows.map((row) => row.id);
  }

  async insertRun(tx: DbTransaction, values: NewWorkflowRunRow): Promise<string> {
    const [row] = await tx.insert(workflowRuns).values(values).returning({ id: workflowRuns.id });
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The run insert returned no row');
    }
    return row.id;
  }

  /**
   * Claims a time-based match: the run row with its `match_key`, or nothing when
   * this rule already acted on this ticket for this stay in its status.
   */
  async claimMatch(tx: DbTransaction, values: NewWorkflowRunRow): Promise<string | undefined> {
    const [row] = await tx
      .insert(workflowRuns)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: workflowRuns.id });
    return row?.id;
  }

  async setRunOutcome(
    tx: DbTransaction,
    runId: string,
    values: { result: RuleRunResult; details: Record<string, unknown> },
  ): Promise<void> {
    await tx.update(workflowRuns).set(values).where(eq(workflowRuns.id, runId));
  }

  async runs(tx: DbTransaction, filter: RunFilter): Promise<RunRow[]> {
    const rows = await tx
      .select({
        run: workflowRuns,
        prefix: tickets.prefix,
        number: tickets.number,
      })
      .from(workflowRuns)
      .innerJoin(tickets, eq(tickets.id, workflowRuns.ticketId))
      .where(
        and(
          filter.result === undefined ? undefined : eq(workflowRuns.result, filter.result),
          filter.ruleId === undefined ? undefined : eq(workflowRuns.ruleId, filter.ruleId),
          filter.ticketNumber === undefined && filter.ruleName === undefined
            ? undefined
            : or(
                filter.ticketNumber === undefined
                  ? undefined
                  : eq(tickets.number, filter.ticketNumber),
                filter.ruleName === undefined
                  ? undefined
                  : ilike(workflowRuns.ruleName, `%${escapeLike(filter.ruleName)}%`),
              ),
        ),
      )
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(filter.limit);

    return rows.map(({ run, prefix, number }) => ({
      id: run.id,
      ruleId: run.ruleId,
      ruleName: run.ruleName,
      ticketId: run.ticketId,
      ticketReference: `${prefix}-${number}`,
      trigger: run.trigger,
      result: run.result,
      stopReason: run.stopReason,
      depth: run.depth,
      chain: run.chain,
      details: run.details,
      createdAt: run.createdAt,
    }));
  }

  // ------------------------------------------------ what actions look up

  async team(
    tx: DbTransaction,
    teamId: string,
  ): Promise<{ id: string; departmentId: string } | undefined> {
    const [row] = await tx
      .select({ id: teams.id, departmentId: teams.departmentId })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    return row;
  }

  async tagExists(tx: DbTransaction, tagId: string): Promise<boolean> {
    const [row] = await tx.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).limit(1);
    return row !== undefined;
  }

  async status(tx: DbTransaction, statusId: string): Promise<TicketStatusRow | undefined> {
    const [row] = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.id, statusId))
      .limit(1);
    return row;
  }

  /** One of the seeded rows code has to find — `escalated`, `closed` (M1-09). */
  async statusByKey(tx: DbTransaction, key: string): Promise<TicketStatusRow | undefined> {
    const [row] = await tx
      .select()
      .from(ticketStatuses)
      .where(eq(ticketStatuses.systemKey, key))
      .orderBy(asc(ticketStatuses.sortOrder))
      .limit(1);
    return row;
  }

  async brandLocale(tx: DbTransaction, brandId: string): Promise<'en' | 'ar'> {
    const [row] = await tx
      .select({ locale: brands.defaultLocale })
      .from(brands)
      .where(eq(brands.id, brandId))
      .limit(1);
    return row?.locale ?? 'en';
  }

  async contactLocale(tx: DbTransaction, contactId: string): Promise<'en' | 'ar' | null> {
    const [row] = await tx
      .select({ locale: contacts.locale })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    return row?.locale ?? null;
  }

  /** Active members of a team. */
  async teamMemberIds(tx: DbTransaction, teamId: string): Promise<string[]> {
    const rows = await tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(users.deactivatedAt)))
      .orderBy(asc(teamMembers.userId));
    return rows.map((row) => row.userId);
  }

  /** Active Team Leaders whose scope reaches the department (DOMAIN-RULES §1.2). */
  async departmentLeadIds(
    tx: DbTransaction,
    brandId: string,
    departmentId: string,
  ): Promise<string[]> {
    const rows = await tx
      .select({ userId: userBrandRoles.userId })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(
        and(
          eq(userBrandRoles.brandId, brandId),
          eq(userBrandRoles.role, 'team_leader'),
          isNull(users.deactivatedAt),
          or(
            isNull(userBrandRoles.departmentIds),
            sql`${departmentId}::uuid = ANY(${userBrandRoles.departmentIds})`,
          ),
        ),
      )
      .orderBy(asc(userBrandRoles.userId));
    return rows.map((row) => row.userId);
  }

  /** Whether the person holds an active role in this brand. */
  async isActiveMember(tx: DbTransaction, brandId: string, userId: string): Promise<boolean> {
    const [row] = await tx
      .select({ userId: userBrandRoles.userId })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(
        and(
          eq(userBrandRoles.brandId, brandId),
          eq(userBrandRoles.userId, userId),
          isNull(users.deactivatedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** How many of `ids` are rows of that kind in this brand. */
  async countExisting(
    tx: DbTransaction,
    kind: 'status' | 'department' | 'team' | 'tag',
    ids: readonly string[],
  ): Promise<number> {
    const wanted = [...ids];
    const rows = await (() => {
      switch (kind) {
        case 'status':
          return tx
            .select({ id: ticketStatuses.id })
            .from(ticketStatuses)
            .where(inArray(ticketStatuses.id, wanted));
        case 'department':
          return tx
            .select({ id: departments.id })
            .from(departments)
            .where(inArray(departments.id, wanted));
        case 'team':
          return tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, wanted));
        case 'tag':
          return tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, wanted));
      }
    })();
    return rows.length;
  }

  /** How many of `userIds` hold a role in this brand. */
  async countMembers(
    tx: DbTransaction,
    brandId: string,
    userIds: readonly string[],
  ): Promise<number> {
    const rows = await tx
      .select({ id: userBrandRoles.userId })
      .from(userBrandRoles)
      .where(
        and(eq(userBrandRoles.brandId, brandId), inArray(userBrandRoles.userId, [...userIds])),
      );
    return rows.length;
  }

  /** What the test run's header says about the sample ticket. */
  async testTicketSummary(tx: DbTransaction, facts: TicketFacts): Promise<RuleTestTicket> {
    const [ticket] = await tx
      .select({
        subject: tickets.subject,
        contactName: contacts.name,
        departmentName: departments.name,
        teamName: teams.name,
        assigneeName: users.name,
      })
      .from(tickets)
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .leftJoin(contacts, eq(contacts.id, tickets.contactId))
      .leftJoin(teams, eq(teams.id, tickets.teamId))
      .leftJoin(users, eq(users.id, tickets.assigneeId))
      .where(eq(tickets.id, facts.id))
      .limit(1);
    const tagRows =
      facts.tagIds.length === 0
        ? []
        : await tx
            .select({ name: tags.name })
            .from(tags)
            .where(inArray(tags.id, [...facts.tagIds]))
            .orderBy(asc(tags.name));

    return {
      id: facts.id,
      reference: facts.reference,
      subject: ticket?.subject ?? facts.subject,
      contactName: ticket?.contactName ?? null,
      channel: facts.channel,
      departmentName: ticket?.departmentName ?? '',
      teamName: ticket?.teamName ?? null,
      assigneeName: ticket?.assigneeName ?? null,
      tagNames: tagRows.map((row) => row.name),
    };
  }

  /** A ticket by its number, as the test run is asked for one. */
  async ticketIdByNumber(
    tx: DbTransaction,
    brandId: string,
    number: number,
  ): Promise<string | undefined> {
    const [row] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(eq(tickets.brandId, brandId), eq(tickets.number, number), isNull(tickets.deletedAt)),
      )
      .limit(1);
    return row?.id;
  }
}

/** `%` and `_` in a name are literal characters, not patterns. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (match) => `\\${match}`);
