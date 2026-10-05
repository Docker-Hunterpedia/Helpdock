import type { FieldSuggestions, TicketPriority } from '@helpdock/schemas';
import { tokens as designTokens } from '@helpdock/ui';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { Check, Sparkles, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 SuggestedFields (M7-05, M7-07): the DetailsPanel card for the
 * tags, priority and department the assistant suggests — from "Suggest tags,
 * priority, department" or a rule's AI triage in suggest mode. Each row is the
 * change with an accept and a dismiss named for what they do; nothing changes
 * until accepted, and the caption says that a department the agent is not in
 * hides the ticket from them.
 */

export type SuggestedField =
  | { readonly field: 'tag'; readonly tagId: string }
  | { readonly field: 'priority' }
  | { readonly field: 'department' };

export interface SuggestedRow {
  readonly key: string;
  readonly target: SuggestedField;
  readonly label: string;
  /** What it is now, when it changes something; null for a tag added. */
  readonly from: string | null;
  readonly to: string;
}

export const suggestedRows = (
  suggestions: FieldSuggestions,
  {
    tagName,
    departmentName,
    priorityName,
    current,
  }: {
    readonly tagName: (id: string) => string | undefined;
    readonly departmentName: (id: string) => string | undefined;
    readonly priorityName: (priority: TicketPriority) => string;
    readonly current: { readonly priority: TicketPriority; readonly departmentId: string };
  },
  labels: { readonly tag: string; readonly priority: string; readonly department: string },
): SuggestedRow[] => [
  ...suggestions.tagIds.flatMap((tagId) => {
    const name = tagName(tagId);
    return name === undefined
      ? []
      : [
          {
            key: `tag:${tagId}`,
            target: { field: 'tag' as const, tagId },
            label: labels.tag,
            from: null,
            to: name,
          },
        ];
  }),
  ...(suggestions.priority === null || suggestions.priority === current.priority
    ? []
    : [
        {
          key: 'priority',
          target: { field: 'priority' as const },
          label: labels.priority,
          from: priorityName(current.priority),
          to: priorityName(suggestions.priority),
        },
      ]),
  ...(suggestions.departmentId === null || suggestions.departmentId === current.departmentId
    ? []
    : [
        {
          key: 'department',
          target: { field: 'department' as const },
          label: labels.department,
          from: departmentName(current.departmentId) ?? '',
          to: departmentName(suggestions.departmentId) ?? '',
        },
      ]),
];

export function SuggestedFieldsCard({
  rows,
  busy,
  onAccept,
  onDismiss,
  onAcceptAll,
}: {
  readonly rows: readonly SuggestedRow[];
  readonly busy: boolean;
  onAccept(row: SuggestedRow): void;
  onDismiss(row: SuggestedRow): void;
  onAcceptAll(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();

  if (rows.length === 0) {
    return null;
  }

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        padding: 3,
        borderRadius: '10px',
        backgroundColor: tokens['action.primary.tint'],
        border: `1px solid ${designTokens.palette.teal.teal100}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Sparkles size={14} aria-hidden="true" color={tokens['action.primary']} />
        <Typography id={headingId} component="h3" sx={{ fontSize: 13, fontWeight: 600 }}>
          {t('tickets:assist.fields.title')}
        </Typography>
        <Button
          size="small"
          variant="text"
          disabled={busy}
          onClick={onAcceptAll}
          sx={{ marginInlineStart: 'auto' }}
        >
          {t('tickets:assist.fields.acceptAll')}
        </Button>
      </Box>
      <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        {rows.map((row) => (
          <Box component="li" key={row.key} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="caption" sx={{ width: 72, flexShrink: 0, color: 'text.secondary' }}>
              {row.label}
            </Typography>
            <Typography component="span" sx={{ fontSize: 13, flex: 1, minWidth: 0 }}>
              {row.from === null ? null : (
                <>
                  <bdi>{row.from}</bdi>
                  {' → '}
                </>
              )}
              <Box component="bdi" sx={{ fontWeight: 500 }}>
                {row.to}
              </Box>
            </Typography>
            <IconButton
              size="small"
              disabled={busy}
              aria-label={t('tickets:assist.fields.accept', { field: row.label, value: row.to })}
              onClick={() => {
                onAccept(row);
              }}
              sx={{
                width: 28,
                height: 28,
                border: `1px solid ${tokens['border.strong']}`,
                borderRadius: '6px',
                backgroundColor: tokens['bg.surface'],
                color: tokens['status.success'],
              }}
            >
              <Check size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="small"
              disabled={busy}
              aria-label={t('tickets:assist.fields.dismiss', { field: row.label, value: row.to })}
              onClick={() => {
                onDismiss(row);
              }}
              sx={{ width: 28, height: 28 }}
            >
              <X size={16} aria-hidden="true" />
            </IconButton>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:assist.fields.caption')}
      </Typography>
    </Box>
  );
}
