import {
  type ImportMappingTargetChoice,
  type ImportMappingTargetsQuery,
  importMappingTargetsQuerySchema,
  importMappingTargetsSchema,
  ticketChannelSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import type { StaffApi } from '../staff/api.js';
import type { TicketingApi } from '../ticketing/api.js';

export type MockImportTargetApis = { ticketing: TicketingApi; staff: StaffApi };

async function choicesFor(
  apis: MockImportTargetApis | undefined,
  brandId: string,
  query: ImportMappingTargetsQuery,
): Promise<ImportMappingTargetChoice[]> {
  const externalValue = query.externalValue;
  if (query.kind === 'priority')
    return ticketPrioritySchema.options.map((priority) => ({
      id: priority,
      label: priority,
      nameAr: null,
      detail: null,
      selection: { kind: 'priority', externalValue, target: { priority } },
    }));
  if (query.kind === 'channel')
    return ticketChannelSchema.options.map((channel) => ({
      id: channel,
      label: channel,
      nameAr: null,
      detail: null,
      selection: { kind: 'channel', externalValue, target: { channel } },
    }));
  if (!apis) throw new Error('import.mock-targets-unavailable');
  switch (query.kind) {
    case 'status':
      return (await apis.ticketing.statuses(brandId)).statuses.map((status) => ({
        id: status.id,
        label: status.name,
        nameAr: status.nameAr,
        detail: null,
        selection: { kind: 'status', externalValue, target: { statusId: status.id } },
      }));
    case 'tag':
      return (await apis.ticketing.tags(brandId)).tags.map((tag) => ({
        id: tag.id,
        label: tag.name,
        nameAr: null,
        detail: null,
        selection: { kind: 'tag', externalValue, target: { tagId: tag.id } },
      }));
    case 'agent':
      return (await apis.staff.listStaff(brandId, query.search)).staff
        .filter(
          (person) => person.role !== 'viewer' && ['active', 'invited'].includes(person.status),
        )
        .map((person) => ({
          id: person.userId,
          label: person.name,
          nameAr: null,
          detail: person.email,
          selection: {
            kind: 'agent',
            externalValue,
            target: { kind: 'existing', userId: person.userId },
          },
        }));
    case 'group': {
      const departments = (await apis.ticketing.departments(brandId)).departments;
      const choices: ImportMappingTargetChoice[] = departments.map((department) => ({
        id: `department:${department.id}`,
        label: department.name,
        nameAr: department.nameAr,
        detail: null,
        selection: {
          kind: 'group',
          externalValue,
          target: { departmentId: department.id, teamId: null },
        },
      }));
      for (const department of departments) {
        const teams = await apis.ticketing.teams(brandId, department.id);
        choices.push(
          ...teams.teams.map<ImportMappingTargetChoice>((team) => ({
            id: `team:${team.id}`,
            label: team.name,
            nameAr: null,
            detail: department.name,
            selection: {
              kind: 'group',
              externalValue,
              target: { departmentId: department.id, teamId: team.id },
            },
          })),
        );
      }
      return choices;
    }
    case 'field':
      return (await apis.ticketing.customFields(brandId, 'ticket')).fields
        .filter((field) => field.type === 'text')
        .map((field) => ({
          id: field.id,
          label: field.label,
          nameAr: field.labelAr,
          detail: field.key,
          selection: {
            kind: 'field',
            externalValue,
            target: { kind: 'existing', fieldId: field.id },
          },
        }));
  }
}

export async function mockImportTargetChoices(
  apis: MockImportTargetApis | undefined,
  brandId: string,
  raw: ImportMappingTargetsQuery,
) {
  const query = importMappingTargetsQuerySchema.parse(raw);
  const search = query.search.toLowerCase();
  const choices = (await choicesFor(apis, brandId, query))
    .filter(
      (choice) =>
        [choice.id, choice.label, choice.nameAr, choice.detail].some((part) =>
          part?.toLowerCase().includes(search),
        ) &&
        (query.after === undefined || choice.id > query.after),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = choices.slice(0, query.limit);
  return importMappingTargetsSchema.parse({
    choices: page,
    nextCursor: choices.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  });
}
