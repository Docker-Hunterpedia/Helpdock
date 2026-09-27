import type { DbTransaction, SlaPolicyRow } from '@helpdock/db';
import {
  type BrandSettings,
  parseBrandSettings,
  SLA_POLICIES_MAX,
  type SlaCondition,
  type SlaPolicy,
  type SlaPolicyCreateRequest,
  type SlaPolicyList,
  type SlaPolicyReorderRequest,
  type SlaSettingsUpdateRequest,
  type TicketingRefusal,
} from '@helpdock/schemas';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import type { SlaAdminContext } from './business-hours.service.js';
import type { SlaRepository, StoredPolicy } from './sla.repository.js';
import type { SlaService } from './sla.service.js';
import { policyRefusal, reorderRefusal } from './sla-scope.js';

/**
 * The SLAs tab (M3-02): the policies, their order, and the two brand settings
 * that apply whichever policy a ticket uses.
 *
 * Every write that can change which policy a ticket runs under, or what that
 * policy asks, runs inside {@link SlaService.recompute}: "Saving recomputes
 * both clocks on the open tickets under this policy, keeping the time already
 * counted. A ticket whose new target is already used up is recorded as
 * breached at the moment you save" (§3.3).
 */
export class SlaPoliciesService {
  readonly #repository: SlaRepository;
  readonly #sla: SlaService;

  constructor(repository: SlaRepository, sla: SlaService) {
    this.#repository = repository;
    this.#sla = sla;
  }

  async list(tx: DbTransaction): Promise<SlaPolicyList> {
    const rows = await this.#repository.policyRows(tx);
    const policies = new Map(
      (await this.#repository.policies(tx)).map((policy) => [policy.id, policy]),
    );
    const running = await this.#repository.runningTicketsByPolicy(tx);

    return {
      policies: rows.flatMap(({ policy: row, updatedByName }) => {
        const policy = policies.get(row.id);
        return policy === undefined
          ? []
          : [toPolicy(policy, row, updatedByName, running.get(row.id) ?? 0)];
      }),
    };
  }

  async create(context: SlaAdminContext, request: SlaPolicyCreateRequest): Promise<SlaPolicy> {
    refuse(policyRefusal(context.actor, request.conditions));
    await this.#requireDepartments(context.tx, request.conditions);
    if ((await this.#repository.countPolicies(context.tx)) >= SLA_POLICIES_MAX) {
      throw new ConflictException('This brand already has the most SLA policies it can hold');
    }

    const row = await this.#sla.recompute(context.tx, context.brandId, context.now, async () =>
      this.#repository.insertPolicy(context.tx, {
        brandId: context.brandId,
        position: await this.#repository.countPolicies(context.tx),
        updatedById: context.actor.userId,
        ...request,
      }),
    );
    await this.#audit(context, 'sla_policy.created', row.id, { name: row.name });

    return this.#one(context.tx, row.id);
  }

  async update(
    context: SlaAdminContext,
    policyId: string,
    request: SlaPolicyCreateRequest,
  ): Promise<SlaPolicy> {
    const existing = await this.#require(context.tx, policyId);
    refuse(policyRefusal(context.actor, existing.conditions, request.conditions));
    await this.#requireDepartments(context.tx, request.conditions);

    await this.#sla.recompute(context.tx, context.brandId, context.now, () =>
      this.#repository.updatePolicy(context.tx, policyId, {
        ...request,
        updatedById: context.actor.userId,
      }),
    );
    await this.#audit(context, 'sla_policy.updated', policyId, { name: request.name });

    return this.#one(context.tx, policyId);
  }

  /** The policy goes; its tickets fall to the next policy that matches, or to none. */
  async remove(context: SlaAdminContext, policyId: string): Promise<void> {
    const existing = await this.#require(context.tx, policyId);
    refuse(policyRefusal(context.actor, existing.conditions));

    await this.#sla.recompute(context.tx, context.brandId, context.now, async () => {
      await this.#repository.deletePolicy(context.tx, policyId);
      await this.#compact(context.tx);
    });
    await this.#audit(context, 'sla_policy.deleted', policyId, { name: existing.name });
  }

  /** The whole list in its new order. Ids it does not know are skipped, as for statuses. */
  async reorder(
    context: SlaAdminContext,
    request: SlaPolicyReorderRequest,
  ): Promise<SlaPolicyList> {
    refuse(reorderRefusal(context.actor));

    await this.#sla.recompute(context.tx, context.brandId, context.now, async () => {
      const known = new Set((await this.#repository.policies(context.tx)).map(({ id }) => id));
      let position = 0;
      for (const policyId of request.policyIds) {
        if (known.has(policyId)) {
          await this.#repository.setPolicyPosition(context.tx, policyId, position);
          position += 1;
        }
      }
    });
    await this.#audit(context, 'sla_policy.reordered', context.brandId, {
      order: request.policyIds,
    });

    return this.list(context.tx);
  }

  /**
   * "For every policy": `aiCountsAsFirstResponse` and `slaCountReopens`,
   * merged into `brands.settings` the way the reply behaviour is, so a key a
   * later milestone adds is not reset by a screen that predates it.
   */
  async updateSettings(
    context: SlaAdminContext,
    request: SlaSettingsUpdateRequest,
  ): Promise<BrandSettings> {
    const current = await this.#repository.brandSettings(context.tx, context.brandId);
    const defined = Object.fromEntries(
      Object.entries(request).filter(([, value]) => value !== undefined),
    );
    const settings = parseBrandSettings({ ...current, ...defined });

    await this.#repository.updateBrandSettings(context.tx, context.brandId, settings);
    await this.#audit(context, 'brand.sla_settings.updated', context.brandId, {
      changed: Object.keys(defined),
    });

    return settings;
  }

  // ---------------------------------------------------------------- internals

  async #one(tx: DbTransaction, policyId: string): Promise<SlaPolicy> {
    const found = (await this.list(tx)).policies.find((policy) => policy.id === policyId);
    /* c8 ignore next 3 -- the row was written through this transaction. */
    if (found === undefined) {
      throw new NotFoundException('No such SLA policy');
    }
    return found;
  }

  async #require(tx: DbTransaction, policyId: string): Promise<StoredPolicy> {
    const policy = (await this.#repository.policies(tx)).find(({ id }) => id === policyId);
    if (policy === undefined) {
      // Another brand's policy is invisible here, so it answers the same.
      throw new NotFoundException('No such SLA policy');
    }
    return policy;
  }

  /** Every department a condition names has to be one of this brand's. */
  async #requireDepartments(tx: DbTransaction, conditions: readonly SlaCondition[]): Promise<void> {
    const named = conditions.flatMap((condition) =>
      condition.field === 'department' ? condition.values : [],
    );
    if (named.length === 0) {
      return;
    }
    const known = new Set((await this.#repository.listDepartments(tx)).map(({ id }) => id));
    if (named.some((departmentId) => !known.has(departmentId))) {
      throw new NotFoundException('No such department in this brand');
    }
  }

  /** Dense and zero-based after a delete, as the reorder leaves it. */
  async #compact(tx: DbTransaction): Promise<void> {
    const remaining = await this.#repository.policies(tx);
    for (const [position, policy] of remaining.entries()) {
      if (policy.position !== position) {
        await this.#repository.setPolicyPosition(tx, policy.id, position);
      }
    }
  }

  async #audit(
    context: SlaAdminContext,
    action: string,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.#repository.writeAudit(context.tx, {
      brandId: context.brandId,
      actorType: context.auditActor.actorType,
      actorId: context.auditActor.actorId,
      action,
      targetType: action.startsWith('brand.') ? 'brand' : 'sla_policy',
      targetId,
      meta,
    });
  }
}

const refuse = (reason: TicketingRefusal | null): void => {
  if (reason !== null) {
    throw new TicketingFailure(reason);
  }
};

const toPolicy = (
  policy: StoredPolicy,
  row: SlaPolicyRow,
  updatedByName: string | null,
  runningTickets: number,
): SlaPolicy => ({
  id: policy.id,
  name: policy.name,
  position: policy.position,
  conditions: [...policy.conditions],
  timeMode: policy.timeMode,
  targets: policy.targets,
  escalation: [...policy.escalation],
  runningTickets,
  updatedAt: row.updatedAt.toISOString(),
  updatedBy:
    row.updatedById === null || updatedByName === null
      ? null
      : { id: row.updatedById, name: updatedByName },
});
