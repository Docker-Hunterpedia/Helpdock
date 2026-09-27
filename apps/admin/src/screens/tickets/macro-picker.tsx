import type { Macro, MacroKind, RenderedMacro, Ticket } from '@helpdock/schemas';
import { Box, Button, Paper, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { useTicketingApi, useTicketsApi } from '../../auth/session.tsx';
import {
  describeAction,
  type StagedLine,
  type StagingLookups,
} from '../../tickets/macro-staging.js';

/**
 * "Insert a macro or canned response" (M3-06, artboard `AdminComposerMacros`,
 * DESIGN §6.4 MacroPicker): a search that is a combobox, the results as a
 * listbox, and beside them the selected item filled in for this ticket, with
 * the words that came from placeholders marked, and what its actions will do
 * when the reply is sent.
 *
 * It offers only what may be used here — shared with the ticket's department,
 * shared with every department, or the reader's own — and fills the reply in
 * the contact's language, with a one-click switch to the other.
 *
 * ↑ and ↓ move, Enter applies, Esc closes.
 */

type Filter = 'all' | MacroKind;
type Locale = 'en' | 'ar';

export interface MacroPickerProps {
  readonly brandId: string;
  readonly ticket: Ticket;
  readonly departmentName: string;
  /** The contact's language, which picks the variant first. */
  readonly contactLocale: Locale;
  readonly contactName: string | null;
  readonly lookups: StagingLookups;
  onApply(macro: Macro, rendered: RenderedMacro | null): void;
  onClose(): void;
}

export function MacroPicker({
  brandId,
  ticket,
  departmentName,
  contactLocale,
  contactName,
  lookups,
  onApply,
  onClose,
}: MacroPickerProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const ticketingApi = useTicketingApi();
  const ticketsApi = useTicketsApi();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [active, setActive] = useState(0);
  const [locale, setLocale] = useState<Locale>(contactLocale);

  const macros = useQuery({
    queryKey: ['macros', brandId, 'department', ticket.departmentId],
    queryFn: () => ticketingApi.macros(brandId, { departmentId: ticket.departmentId }),
  });

  const needle = term.trim().toLowerCase();
  const results = (macros.data?.macros ?? []).filter(
    (row) =>
      (filter === 'all' || row.kind === filter) &&
      (needle === '' ||
        row.name.toLowerCase().includes(needle) ||
        `${row.bodies.en} ${row.bodies.ar}`.toLowerCase().includes(needle)),
  );
  const selected = results[Math.min(active, results.length - 1)];
  const hasReply = selected !== undefined && selected.bodies.en.trim() !== '';

  const rendered = useQuery({
    queryKey: ['macro-render', brandId, ticket.id, selected?.id, locale],
    queryFn: () => ticketsApi.renderMacro(brandId, ticket.id, selected?.id ?? '', locale),
    enabled: hasReply,
  });

  const apply = (): void => {
    if (selected !== undefined && (!hasReply || rendered.data !== undefined)) {
      onApply(selected, hasReply ? (rendered.data ?? null) : null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) =>
        results.length === 0 ? 0 : (index + step + results.length) % results.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const optionId = (id: string): string => `${listId}-${id}`;
  const lines: StagedLine[] =
    selected?.actions.map((action) => describeAction(action, ticket, lookups)) ?? [];

  return (
    <Paper
      role="dialog"
      aria-label={t('macros:picker.label')}
      elevation={3}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
      sx={{ padding: 4, display: 'grid', gap: 3, borderRadius: '10px', marginBlockEnd: 3 }}
    >
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          size="small"
          type="search"
          autoFocus
          value={term}
          placeholder={t('macros:picker.search')}
          onChange={(event) => {
            setTerm(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          slotProps={{
            htmlInput: {
              role: 'combobox',
              'aria-label': t('macros:picker.search'),
              'aria-expanded': true,
              'aria-controls': listId,
              'aria-activedescendant': selected === undefined ? undefined : optionId(selected.id),
            },
          }}
          sx={{ flex: 1, minWidth: 200 }}
        />
        <Box
          role="group"
          aria-label={t('macros:list.filter.label')}
          sx={{ display: 'flex', gap: 1 }}
        >
          {(['all', 'macro', 'canned'] as const).map((value) => (
            <Button
              key={value}
              size="small"
              variant={filter === value ? 'contained' : 'outlined'}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setActive(0);
              }}
            >
              {t(`macros:list.filter.${value}`)}
            </Button>
          ))}
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: '5fr 7fr' } }}>
        <Box>
          <Box id={listId} role="listbox" aria-label={t('macros:picker.results')}>
            {results.map((row, index) => (
              <Box
                key={row.id}
                id={optionId(row.id)}
                role="option"
                aria-selected={row.id === selected?.id}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setActive(index);
                }}
                sx={{
                  display: 'grid',
                  paddingBlock: 1,
                  paddingInline: 2,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor:
                    row.id === selected?.id ? tokens['action.primary.tint'] : undefined,
                  '&:hover': { backgroundColor: tokens['bg.muted'] },
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {row.name}
                </Typography>
                <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>
                  {optionCaption(row, t)}
                </Typography>
              </Box>
            ))}
            {results.length === 0 && !macros.isPending ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', padding: 2 }}>
                {t('macros:picker.none')}
              </Typography>
            ) : null}
          </Box>
          <Typography
            variant="caption"
            component="p"
            sx={{ color: 'text.secondary', marginBlockStart: 2 }}
          >
            {t('macros:picker.scopeNote', { department: departmentName })}
          </Typography>
        </Box>

        <Box sx={{ display: 'grid', gap: 2, alignContent: 'start', minWidth: 0 }}>
          {hasReply ? (
            <>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {t(`macros:picker.variant.${rendered.data?.locale ?? locale}`)}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {rendered.data?.fellBack === true
                    ? t('macros:picker.fellBack')
                    : contactName === null
                      ? null
                      : t(`macros:picker.contactLanguage.${contactLocale}`, { name: contactName })}
                </Typography>
                <Button
                  size="small"
                  variant="text"
                  onClick={() => {
                    setLocale(locale === 'ar' ? 'en' : 'ar');
                  }}
                  sx={{ marginInlineStart: 'auto' }}
                >
                  {t(locale === 'ar' ? 'macros:picker.useEnglish' : 'macros:picker.useArabic')}
                </Button>
              </Box>
              <Box
                lang={rendered.data?.locale ?? locale}
                dir={(rendered.data?.locale ?? locale) === 'ar' ? 'rtl' : 'ltr'}
                aria-live="polite"
                sx={{
                  whiteSpace: 'pre-line',
                  padding: 3,
                  borderRadius: '6px',
                  border: `1px solid ${tokens['border.default']}`,
                  backgroundColor: tokens['bg.canvas'],
                  fontSize: 14,
                }}
              >
                {rendered.data === undefined ? null : (
                  <Segments segments={rendered.data.segments} />
                )}
              </Box>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('macros:picker.highlightNote')}
              </Typography>
            </>
          ) : selected === undefined ? null : (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('macros:picker.noReply')}
            </Typography>
          )}

          {lines.length === 0 ? null : (
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {t(hasReply ? 'macros:picker.whenSent' : 'macros:picker.atOnce')}
              </Typography>
              <Box component="ul" sx={{ margin: 0, paddingInlineStart: 5 }}>
                {lines.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: one line per action, in order.
                  <li key={index}>
                    <Typography variant="body2" component="span">
                      {lineText(line, t)}
                    </Typography>
                  </li>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1 }}>
          {t('macros:picker.keys')}
        </Typography>
        <Button variant="text" onClick={onClose}>
          {t('macros:picker.cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={selected === undefined || (hasReply && rendered.data === undefined)}
          onClick={apply}
        >
          {t(selected?.kind === 'canned' ? 'macros:picker.insert' : 'macros:picker.apply')}
        </Button>
      </Box>
    </Paper>
  );
}

const optionCaption = (row: Macro, t: ReturnType<typeof useT>): string => {
  if (row.kind === 'macro') {
    return row.bodies.en.trim() === ''
      ? t('macros:picker.optionMacroNoReply', { count: row.actions.length })
      : t('macros:picker.optionMacro', { count: row.actions.length });
  }

  const first = row.bodies.en.split('\n')[0] ?? '';
  return row.scope === 'personal'
    ? t('macros:picker.optionPersonal', { text: first })
    : t('macros:picker.optionCanned', { text: first });
};

/** One "When you send the reply" line, in words. */
export const lineText = (line: StagedLine, t: ReturnType<typeof useT>): string => {
  switch (line.field) {
    case 'status':
      return t('macros:staged.status', { from: line.from, to: line.to });
    case 'priority':
      return t('macros:staged.priority', { from: line.from, to: line.to });
    case 'tag':
      return t(line.add ? 'macros:staged.tagAdd' : 'macros:staged.tagRemove', { name: line.name });
    case 'assignee':
      return line.to === null
        ? t('macros:staged.unassign')
        : t(line.unchanged ? 'macros:staged.assigneeStays' : 'macros:staged.assignee', {
            name: line.to,
          });
  }
};

/**
 * The filled-in reply, with the runs that came from a placeholder marked. Each
 * run is keyed by where it starts in the text, which is stable for one render.
 */
function Segments({ segments }: { readonly segments: RenderedMacro['segments'] }): ReactNode {
  const tokens = useSemanticTokens();
  const starts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    starts.push(offset);
    offset += segment.text.length;
  }

  return segments.map((segment, index) =>
    segment.placeholder === null ? (
      <span key={starts[index]}>{segment.text}</span>
    ) : (
      <Box
        component="mark"
        key={starts[index]}
        sx={{
          backgroundColor: tokens['status.warning.tint'],
          color: 'inherit',
          borderRadius: '4px',
          paddingInline: '2px',
        }}
      >
        <bdi>{segment.text}</bdi>
      </Box>
    ),
  );
}
