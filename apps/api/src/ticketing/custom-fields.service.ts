import type { CustomFieldDefRow, DbTransaction } from '@helpdock/db';
import type {
  CustomFieldCreateRequest,
  CustomFieldDef,
  CustomFieldDefList,
  CustomFieldReorderRequest,
  CustomFieldTarget,
  CustomFieldType,
  CustomFieldUpdateRequest,
  CustomFieldUsage,
} from '@helpdock/schemas';
import { isChoiceField } from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from './audit.js';
import type { CustomFieldsRepository, FieldUsage } from './custom-fields.repository.js';
import type { TicketingActor, TicketingContext } from './ticketing-context.js';

/**
 * The definitions behind every `custom jsonb` value (M1-06), the Custom fields
 * tab of the Ticketing settings screen.
 *
 * Three rules are what make this more than CRUD, and all three exist because
 * the values are already written by the time somebody edits a definition.
 *
 * **A key never moves.** It is absent from the update request rather than
 * refused in a branch, because it is written into every stored value, every
 * template default and — from M3 — every rule condition. Renaming it would
 * orphan all of them silently. The label is what a person reads and may be
 * corrected at any time.
 *
 * **A type never moves once a value exists.** "Yes" is not a number and
 * "2026-01-02" is not one of three options; changing the type under stored
 * values would leave rows that no longer validate and that nobody can save
 * again. The refusal carries a count, so the screen can say how many.
 *
 * **An option in use is not removed by accident.** The api refuses and answers
 * with how many rows carry it; the editor asks; the same request with `force`
 * removes the option *and* clears it from those rows, so nothing is left
 * pointing at a choice that no longer exists.
 */
export class CustomFieldsService {
  readonly #repository: CustomFieldsRepository;

  constructor(repository: CustomFieldsRepository) {
    this.#repository = repository;
  }

  /**
   * Readable by anybody who may read a ticket: the details panel draws the
   * fields, and a second endpoint for the same rows would be a second answer to
   * what a brand's fields are. `agentVisible` is a display rule the screen
   * applies and never a security boundary — the value sits in the same jsonb
   * column either way.
   */
  async list(tx: DbTransaction, target?: CustomFieldTarget): Promise<CustomFieldDefList> {
    const rows = await this.#repository.list(tx, target);

    return { fields: rows.map(toDef) };
  }

  async usage(tx: DbTransaction, fieldId: string): Promise<CustomFieldUsage> {
    const def = await this.#require(tx, fieldId);
    const usage = await this.#repository.usage(tx, def);

    return { fieldId, rows: usage.rows, optionRows: usage.optionRows };
  }

  async create(
    context: TicketingContext,
    request: CustomFieldCreateRequest,
  ): Promise<CustomFieldDef> {
    if (await this.#repository.keyTaken(context.tx, request.target, request.key)) {
      throw new TicketingFailure('name-taken');
    }

    const created = await this.#repository.create(context.tx, {
      brandId: context.brandId,
      target: request.target,
      key: request.key,
      label: request.label,
      labelAr: request.labelAr ?? null,
      type: request.type,
      options: [...request.options],
      required: request.required,
      agentVisible: request.agentVisible,
      sortOrder: await this.#repository.nextSortOrder(context.tx, request.target),
    });

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'custom_field.created',
      targetType: 'custom_field',
      targetId: created.id,
      meta: { target: created.target, key: created.key, type: created.type },
    });

    return toDef(created);
  }

  async update(
    context: TicketingContext,
    fieldId: string,
    request: CustomFieldUpdateRequest,
  ): Promise<CustomFieldDef> {
    const def = await this.#require(context.tx, fieldId);
    const usage = await this.#repository.usage(context.tx, def);
    const movesType = request.type !== undefined && request.type !== def.type;

    // A count is only ever of rows the actor can see (`custom-fields.repository.ts`),
    // and `tickets` is department-scoped. So an actor who does not reach every
    // department may not make a change that rewrites stored values: they would
    // be deciding on a number that leaves out the tickets they cannot read, and
    // the rows left behind would fail validation the next time anybody saved
    // them. An Admin always reaches every department, and so does an
    // unrestricted Team Leader.
    if ((movesType || request.force) && !seesEveryDepartment(context.actor)) {
      throw new TicketingFailure('out-of-scope');
    }

    if (movesType && usage.rows > 0) {
      throw new TicketingFailure('field-in-use');
    }

    const options = request.options === undefined ? undefined : [...request.options];
    // The request may name options without naming a type, so the schema cannot
    // check the pair on its own: only the stored row knows what the type is.
    assertOptionsMatchType(request.type ?? def.type, options ?? def.options);

    if (options !== undefined) {
      await this.#applyOptionRemovals(context, def, options, usage, request.force);
    }

    await this.#repository.update(context.tx, fieldId, {
      ...(request.label === undefined ? {} : { label: request.label }),
      ...(request.labelAr === undefined ? {} : { labelAr: request.labelAr }),
      ...(request.type === undefined ? {} : { type: request.type }),
      ...(options === undefined ? {} : { options }),
      ...(request.required === undefined ? {} : { required: request.required }),
      ...(request.agentVisible === undefined ? {} : { agentVisible: request.agentVisible }),
    });

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'custom_field.updated',
      targetType: 'custom_field',
      targetId: fieldId,
      meta: {
        key: def.key,
        ...(request.label === undefined ? {} : { label: request.label, wasLabelled: def.label }),
        ...(request.labelAr === undefined ? {} : { labelAr: request.labelAr }),
        ...(request.type === undefined ? {} : { type: request.type, wasTyped: def.type }),
        ...(options === undefined ? {} : { options, wasOptioned: def.options }),
        ...(request.required === undefined ? {} : { required: request.required }),
        ...(request.agentVisible === undefined ? {} : { agentVisible: request.agentVisible }),
      },
    });

    return toDef(await this.#require(context.tx, fieldId));
  }

  /**
   * Deletes the definition. The stored values stay where they are and become
   * invisible, which is the repository's decision and its comment explains it;
   * the count goes into the audit row so the size of what was hidden is on the
   * record.
   */
  async remove(context: TicketingContext, fieldId: string): Promise<void> {
    const def = await this.#require(context.tx, fieldId);
    const usage = await this.#repository.usage(context.tx, def);

    await this.#repository.delete(context.tx, fieldId);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'custom_field.deleted',
      targetType: 'custom_field',
      targetId: fieldId,
      meta: { target: def.target, key: def.key, hiddenOn: usage.rows },
    });
  }

  /** The whole list of one target in its new order, as tags and departments are. */
  async reorder(
    context: TicketingContext,
    request: CustomFieldReorderRequest,
  ): Promise<CustomFieldDefList> {
    const known = new Set(
      (await this.#repository.list(context.tx, request.target)).map((row) => row.id),
    );
    const unique = new Set(request.fieldIds);

    if (unique.size !== request.fieldIds.length) {
      throw new BadRequestException('The order names a field twice');
    }
    if (unique.size !== known.size || request.fieldIds.some((id) => !known.has(id))) {
      throw new BadRequestException('The order must name every field of this target exactly once');
    }

    await this.#repository.reorder(context.tx, request.fieldIds);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'custom_field.reordered',
      targetType: 'brand',
      targetId: context.brandId,
      meta: { target: request.target, order: request.fieldIds },
    });

    return this.list(context.tx, request.target);
  }

  // ------------------------------------------------------------------

  /**
   * Refuses, or clears, every option the request drops that rows still carry.
   *
   * The refusal is one code for all of them rather than one per option: the
   * editor's question is "these are still in use, remove them anyway?", and a
   * dialog per option would be the same question asked four times.
   */
  async #applyOptionRemovals(
    context: TicketingContext,
    def: CustomFieldDefRow,
    options: readonly string[],
    usage: FieldUsage,
    force: boolean,
  ): Promise<void> {
    if (!isChoiceField(def.type)) {
      return;
    }

    const kept = new Set(options);
    const removed = def.options.filter((option) => !kept.has(option));
    if (removed.length === 0) {
      return;
    }

    const inUse = removed.filter((option) => (usage.optionRows[option] ?? 0) > 0);

    if (inUse.length > 0 && !force) {
      throw new TicketingFailure('option-in-use');
    }

    for (const option of inUse) {
      await this.#repository.clearOption(context.tx, def, option);
    }
  }

  async #require(tx: DbTransaction, fieldId: string): Promise<CustomFieldDefRow> {
    const def = await this.#repository.find(tx, fieldId);
    if (def === undefined) {
      throw new NotFoundException('No such custom field');
    }

    return def;
  }
}

/**
 * Whether every ticket in the brand is visible to this actor, which is what a
 * usage count has to cover before it can be acted on.
 */
const seesEveryDepartment = (actor: TicketingActor): boolean => actor.departmentIds === 'all';

/**
 * A choice type with no options accepts nothing and shows an empty menu; a
 * plain type with options carries a list nothing reads. The create request
 * refuses both, and this is the same rule for an update — which may name
 * options without naming a type, and so cannot be checked by a schema alone.
 */
const assertOptionsMatchType = (type: CustomFieldType, options: readonly string[]): void => {
  if (isChoiceField(type) && options.length === 0) {
    throw new BadRequestException('A select field needs at least one option');
  }
  if (!isChoiceField(type) && options.length > 0) {
    throw new BadRequestException('Only select fields carry options');
  }
};

const toDef = (row: CustomFieldDefRow): CustomFieldDef => ({
  id: row.id,
  target: row.target,
  key: row.key,
  label: row.label,
  labelAr: row.labelAr,
  type: row.type,
  options: row.options,
  required: row.required,
  agentVisible: row.agentVisible,
  sortOrder: row.sortOrder,
});
