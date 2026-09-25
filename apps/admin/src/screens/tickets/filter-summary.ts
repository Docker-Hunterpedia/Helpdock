import type { Department, StaffMember, TagSummary, TicketStatus } from '@helpdock/schemas';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { EMPTY_FILTERS, LIVE_STATES, type WorkspaceFilters } from '../../tickets/views.js';
import { shortId } from './directory.js';
import { statusName } from './format.js';

/**
 * A filter set in words (M1-05), for three places that print one: the chips
 * under the list header, each removable; the "Saves" line of the save dialog;
 * and the "Shows" column of the Views tab.
 *
 * Every name is looked up in the reads the workspace already has. An id that
 * is not among them — a department deleted since, a tag another brand's link
 * carried — is shortened rather than dropped, so the words never claim a filter
 * is narrower than the query it describes.
 */

export interface FilterDirectory {
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly tags: readonly TagSummary[];
  readonly staff: readonly Pick<StaffMember, 'userId' | 'name'>[];
}

/** One chip: what it says, and the filters without it. */
export interface FilterChipPart {
  readonly key: string;
  readonly label: string;
  readonly without: WorkspaceFilters;
}

export interface FilterSummary {
  /** One chip per value that is on. */
  chips(filters: WorkspaceFilters): readonly FilterChipPart[];
  /** One phrase per field, joined as the artboards print them: "Status is live · Assignee is me". */
  sentence(filters: WorkspaceFilters, options?: { readonly withSort?: boolean }): string;
}

const isLive = (states: readonly string[]): boolean =>
  states.length === LIVE_STATES.length && LIVE_STATES.every((state) => states.includes(state));

export function useFilterSummary(directory: FilterDirectory): FilterSummary {
  const t = useT();
  const { locale } = usePreferences();

  const named = <T extends { readonly id: string }>(
    rows: readonly T[],
    id: string,
    name: (row: T) => string,
  ): string => {
    const row = rows.find((candidate) => candidate.id === id);
    return row === undefined ? shortId(id) : name(row);
  };

  const departmentName = (id: string) => named(directory.departments, id, (row) => row.name);
  const tagName = (id: string) =>
    named(directory.tags, id, (row) =>
      locale === 'ar' && row.nameAr !== null ? row.nameAr : row.name,
    );
  const assignee = (id: string): string => {
    if (id === 'me') {
      return t('tickets:summary.me');
    }
    if (id === 'unassigned') {
      return t('tickets:summary.nobody');
    }
    return directory.staff.find((member) => member.userId === id)?.name ?? shortId(id);
  };

  const fields = (filters: WorkspaceFilters) => [
    {
      field: 'systemState' as const,
      name: t('tickets:filters.status'),
      values: filters.systemState,
      label: (state: string) => t(`tickets:filters.states.${state as 'open'}`),
    },
    {
      field: 'statusId' as const,
      name: t('tickets:filters.status'),
      values: filters.statusId,
      label: (id: string) => named(directory.statuses, id, (row) => statusName(row, locale)),
    },
    {
      field: 'priority' as const,
      name: t('tickets:filters.priority'),
      values: filters.priority,
      label: (value: string) => t(`tickets:priority.${value as 'low'}`),
    },
    {
      field: 'assigneeId' as const,
      name: t('tickets:filters.assignee'),
      values: filters.assigneeId,
      label: assignee,
    },
    {
      field: 'departmentId' as const,
      name: t('tickets:filters.department'),
      values: filters.departmentId,
      label: departmentName,
    },
    {
      field: 'tagIds' as const,
      name: t('tickets:filters.tag'),
      values: filters.tagIds,
      label: tagName,
    },
    {
      field: 'channel' as const,
      name: t('tickets:channel.label'),
      values: filters.channel,
      label: (value: string) => t(`tickets:channel.${value as 'email'}`),
    },
  ];

  return {
    chips(filters) {
      const parts: FilterChipPart[] = fields(filters).flatMap(({ field, name, values, label }) =>
        values.map((value) => ({
          key: `${field}:${value}`,
          label: t('tickets:summary.chip', { field: name, value: label(value) }),
          without: {
            ...filters,
            [field]: (values as readonly string[]).filter((other) => other !== value),
          },
        })),
      );
      if (filters.overdue) {
        parts.push({
          key: 'overdue',
          label: t('tickets:summary.overdue'),
          without: { ...filters, overdue: false },
        });
      }

      return parts;
    },

    sentence(filters, { withSort = false } = {}) {
      const phrases = fields(filters).flatMap(({ field, name, values, label }) => {
        if (values.length === 0) {
          return [];
        }
        if (field === 'systemState' && isLive(values)) {
          return [t('tickets:summary.is', { field: name, value: t('tickets:summary.live') })];
        }
        const joined = values
          .map(label)
          .join(t(field === 'tagIds' ? 'tickets:summary.and' : 'tickets:summary.or'));
        return [
          field === 'tagIds'
            ? t('tickets:summary.allOf', { field: t('tickets:filters.tags'), value: joined })
            : t('tickets:summary.is', { field: name, value: joined }),
        ];
      });
      if (filters.overdue) {
        phrases.push(t('tickets:summary.overdue'));
      }
      if (filters.q !== '') {
        phrases.push(t('tickets:summary.search', { value: filters.q }));
      }
      if (withSort || filters.sort !== EMPTY_FILTERS.sort || filters.direction !== 'desc') {
        phrases.push(
          t('tickets:summary.sort', {
            value: t(`tickets:sort.${filters.sort}.${filters.direction}`),
          }),
        );
      }

      return phrases.length === 0 ? t('tickets:summary.everything') : phrases.join(' · ');
    },
  };
}
