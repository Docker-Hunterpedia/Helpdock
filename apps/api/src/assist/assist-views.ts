import type { TicketFieldSuggestion } from '@helpdock/db';
import type { FieldSuggestions } from '@helpdock/schemas';

export const suggestionView = (row: TicketFieldSuggestion): FieldSuggestions => ({
  tagIds: row.tagIds,
  priority: row.priority,
  departmentId: row.suggestedDepartmentId,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
});
