import {
  type CustomFieldDef,
  type ImportMapping,
  importMappingsSchema,
  MAX_CUSTOM_FIELDS_PER_TARGET,
} from '@helpdock/schemas';

type ExistingField = Pick<CustomFieldDef, 'id' | 'target' | 'key'>;
export type FieldPlanIssue = {
  externalId: string;
  code:
    | 'field-key-conflict'
    | 'field-capacity'
    | 'field-binding-missing'
    | 'field-binding-conflict';
};

/** Evaluate the complete planned additions, rather than letting sequential writes discover a late conflict. */
export function validateFieldCreationPlan(
  raw: ImportMapping[],
  existing: readonly ExistingField[],
  bindings: ReadonlyMap<string, string>,
): FieldPlanIssue[] {
  const mappings = importMappingsSchema.parse(raw);
  const issues: FieldPlanIssue[] = [];
  const planned = new Map<
    CustomFieldDef['target'],
    { externalId: string; key: string; creates: boolean }[]
  >();
  const byId = new Map(existing.map((field) => [field.id, field]));
  for (const mapping of mappings) {
    if (mapping.kind !== 'field' || mapping.target.kind === 'skip') continue;
    const known = bindings.get(mapping.externalValue);
    const explicit = mapping.target.kind === 'existing' ? mapping.target.fieldId : undefined;
    if (known && explicit && known !== explicit) {
      issues.push({ externalId: mapping.externalValue, code: 'field-binding-conflict' });
      continue;
    }
    const id = known ?? explicit;
    const field = id ? byId.get(id) : undefined;
    if (
      id &&
      (!field ||
        (mapping.target.kind === 'create' && field.target !== mapping.target.definition.target))
    ) {
      issues.push({ externalId: mapping.externalValue, code: 'field-binding-missing' });
      continue;
    }
    const definition = mapping.target.kind === 'create' ? mapping.target.definition : undefined;
    const target = field?.target ?? definition?.target;
    const key = field?.key ?? definition?.key;
    if (target === undefined || key === undefined) continue;
    const fields = planned.get(target) ?? [];
    fields.push({ externalId: mapping.externalValue, key, creates: id === undefined });
    planned.set(target, fields);
  }
  for (const [target, destinations] of planned) {
    const current = existing.filter((field) => field.target === target);
    const keyCounts = new Map<string, number>();
    for (const field of destinations) keyCounts.set(field.key, (keyCounts.get(field.key) ?? 0) + 1);
    const keys = new Set(current.map((field) => field.key));
    const overflow =
      current.length + destinations.filter((field) => field.creates).length >
      MAX_CUSTOM_FIELDS_PER_TARGET;
    for (const field of destinations) {
      if ((field.creates && keys.has(field.key)) || (keyCounts.get(field.key) ?? 0) > 1)
        issues.push({ externalId: field.externalId, code: 'field-key-conflict' });
      if (field.creates && overflow)
        issues.push({ externalId: field.externalId, code: 'field-capacity' });
    }
  }
  return issues;
}
