import type { Macro, MacroKind } from '@helpdock/schemas';
import {
  Box,
  Button,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Pencil, Zap } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import {
  currentBrand,
  useSession,
  useTicketingApi,
  useTicketsApi,
} from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useWorkspaceData } from '../../tickets/use-workspace-data.js';
import { useTicketingAction, useTicketingReport } from '../ticketing/use-ticketing-action.js';
import { draftOf, duplicateOf, emptyDraft, type MacroDraft, requestOf } from './macro-draft.js';
import { MacroEditor } from './macro-editor.tsx';
import { lastUsedLabel, sampleValues } from './macro-format.js';

/**
 * The Macros tab of `Admin/Automation` (M3-06, artboard `AdminAutomationMacros`):
 * the list of macros and canned responses on the start side, the editor on the
 * end side.
 *
 * The list shows what the reader may see — shared with their departments, and
 * their own — and the editor is read-only for a shared item they may not
 * change. The api decides both again; this only keeps somebody from filling in
 * a form that would be refused.
 */

type Filter = 'all' | MacroKind;

/** What the editor has open: a saved item, or a new one not saved yet. */
interface Editing {
  /** Remounts the editor per item, so a draft never leaks between them. */
  readonly key: string;
  readonly macro: Macro | null;
  readonly draft: MacroDraft;
}

export function MacrosTab(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const api = useTicketingApi();
  const ticketsApi = useTicketsApi();
  const session = useSession();
  const brand = currentBrand(session);
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const workspace = useWorkspaceData(brand.id);

  const [term, setTerm] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [department, setDepartment] = useState('');
  const [newMenu, setNewMenu] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState<Macro | null>(null);

  const macros = useQuery({
    queryKey: ['macros', brand.id],
    queryFn: () => api.macros(brand.id),
  });
  const teams = useQuery({
    queryKey: ['teams', brand.id, department],
    queryFn: () => api.teams(brand.id, department),
    enabled: department !== '',
  });
  const people = useQuery({
    queryKey: ['assignable', brand.id, department],
    queryFn: () => ticketsApi.assignable(brand.id, department),
    enabled: department !== '',
  });

  const rows = macros.data?.macros ?? [];
  const needle = term.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      (filter === 'all' || row.kind === filter) &&
      (needle === '' ||
        row.name.toLowerCase().includes(needle) ||
        `${row.bodies.en} ${row.bodies.ar}`.toLowerCase().includes(needle)),
  );
  const samples = useMemo(
    () => sampleValues({ brand: brand.name, agent: session.user.name }),
    [brand.name, session.user.name],
  );

  const departmentName = (id: string | null): string =>
    id === null
      ? t('macros:list.allDepartments')
      : (workspace.departments.find((row) => row.id === id)?.name ?? '—');

  const open = (next: Editing): void => {
    setEditing(next);
    setDepartment(next.draft.scope === 'personal' ? '' : next.draft.departmentId);
  };

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['macros', brand.id] });
  };

  const create = useTicketingAction(
    (draft: MacroDraft) => api.createMacro(brand.id, requestOf(draft)),
    (draft) => t('macros:toast.created', { name: draft.name.trim() }),
    refresh,
    report,
  );
  const update = useTicketingAction(
    (input: { macro: Macro; draft: MacroDraft }) => {
      const { kind: _kind, ...request } = requestOf(input.draft);
      return api.updateMacro(brand.id, input.macro.id, request);
    },
    (input) => t('macros:toast.updated', { name: input.draft.name.trim() }),
    refresh,
    report,
  );
  const remove = useTicketingAction(
    (macro: Macro) => api.deleteMacro(brand.id, macro.id),
    (macro) => t('macros:toast.deleted', { name: macro.name }),
    refresh,
    report,
  );
  const busy = [create, update, remove].some((mutation) => mutation.isPending);

  const editedBy = (macro: Macro | null): string | null => {
    if (macro === null) {
      return null;
    }
    const who =
      macro.updatedById === session.user.id
        ? session.user.name
        : workspace.staff.find((person) => person.userId === macro.updatedById)?.name;
    const when = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
      new Date(macro.updatedAt),
    );

    return who === undefined
      ? t('macros:editor.editedOn', { date: when })
      : t('macros:editor.editedBy', { name: who, date: when });
  };

  const filterButton = (value: Filter): ReactNode => (
    <Button
      key={value}
      size="small"
      variant={filter === value ? 'contained' : 'outlined'}
      aria-pressed={filter === value}
      onClick={() => {
        setFilter(value);
      }}
    >
      {t(`macros:list.filter.${value}`)}
    </Button>
  );

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      <Box
        component="section"
        aria-labelledby="macros-list-heading"
        sx={{ flex: '1 1 460px', maxWidth: 640, minWidth: 0, display: 'grid', gap: 3 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography
              id="macros-list-heading"
              variant="h2"
              sx={{ fontSize: 16, fontWeight: 600 }}
            >
              {t('macros:list.heading')}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('macros:list.caption')}
            </Typography>
          </Box>
          <Button
            variant="contained"
            aria-haspopup="menu"
            aria-expanded={newMenu !== null}
            endIcon={<ChevronDown size={16} aria-hidden="true" />}
            onClick={(event) => {
              setNewMenu(event.currentTarget);
            }}
          >
            {t('macros:list.new')}
          </Button>
          <Menu
            anchorEl={newMenu}
            open={newMenu !== null}
            onClose={() => {
              setNewMenu(null);
            }}
          >
            {(['macro', 'canned'] as const).map((kind) => (
              <MenuItem
                key={kind}
                onClick={() => {
                  setNewMenu(null);
                  open({
                    key: `new-${kind}-${Date.now()}`,
                    macro: null,
                    // An Agent may only keep personal ones.
                    draft: emptyDraft(kind, session.user.role === 'agent' ? 'personal' : 'shared'),
                  });
                }}
              >
                {t(`macros:list.newKind.${kind}`)}
              </MenuItem>
            ))}
          </Menu>
        </Box>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            type="search"
            value={term}
            placeholder={t('macros:list.search')}
            onChange={(event) => {
              setTerm(event.target.value);
            }}
            slotProps={{ htmlInput: { 'aria-label': t('macros:list.searchLabel') } }}
            sx={{ flex: 1, minWidth: 200 }}
          />
          <Box
            role="group"
            aria-label={t('macros:list.filter.label')}
            sx={{ display: 'flex', gap: 1 }}
          >
            {filterButton('all')}
            {filterButton('macro')}
            {filterButton('canned')}
          </Box>
        </Box>

        {rows.length === 0 && !macros.isPending ? (
          <EmptyState
            icon={Zap}
            heading={t('macros:list.empty.heading')}
            body={t('macros:list.empty.body')}
          />
        ) : (
          <TableContainer
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Table aria-label={t('macros:list.table', { brand: brand.name })}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell>{t('macros:list.columns.name')}</TableCell>
                  <TableCell>{t('macros:list.columns.scope')}</TableCell>
                  <TableCell>{t('macros:list.columns.department')}</TableCell>
                  <TableCell>{t('macros:list.columns.lastUsed')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((row) => {
                  const selected = editing?.macro?.id === row.id;
                  return (
                    <TableRow
                      key={row.id}
                      sx={{
                        backgroundColor: selected ? tokens['action.primary.tint'] : undefined,
                      }}
                    >
                      <TableCell>
                        <Button
                          variant="text"
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => {
                            open({ key: row.id, macro: row, draft: draftOf(row) });
                          }}
                          sx={{
                            display: 'grid',
                            justifyItems: 'start',
                            textAlign: 'start',
                            paddingInline: 0,
                          }}
                        >
                          <Box component="span" sx={{ fontWeight: 500 }}>
                            {row.name}
                          </Box>
                          <Typography
                            variant="caption"
                            component="span"
                            sx={{ color: 'text.secondary' }}
                          >
                            {rowCaption(row, t)}
                          </Typography>
                        </Button>
                      </TableCell>
                      <TableCell>
                        {row.scope === 'personal' ? (
                          <Typography
                            variant="caption"
                            sx={{
                              backgroundColor: tokens['bg.muted'],
                              color: 'text.secondary',
                              borderRadius: '6px',
                              paddingInline: 2,
                            }}
                          >
                            {t('macros:scope.personal')}
                          </Typography>
                        ) : (
                          t('macros:scope.shared')
                        )}
                      </TableCell>
                      <TableCell>
                        {row.scope === 'personal' ? '—' : departmentName(row.departmentId)}
                      </TableCell>
                      <TableCell>{lastUsedLabel(row.lastUsedAt, locale, Date.now(), t)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Typography
              variant="caption"
              component="p"
              sx={{ color: 'text.secondary', padding: 3, margin: 0 }}
            >
              {t('macros:list.footer', { shown: shown.length, total: rows.length })}
            </Typography>
          </TableContainer>
        )}
      </Box>

      <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
        {editing === null ? (
          <EmptyState
            icon={Pencil}
            heading={t('macros:editor.nothing.heading')}
            body={t('macros:editor.nothing.body')}
          />
        ) : (
          <MacroEditor
            key={editing.key}
            draft={editing.draft}
            macro={editing.macro}
            departments={workspace.departments}
            choices={{
              statuses: workspace.statuses,
              tags: workspace.tags,
              teams: teams.data?.teams ?? [],
              people: (people.data?.agents ?? []).map((agent) => ({
                id: agent.userId,
                name: agent.name,
              })),
            }}
            samples={samples}
            editedBy={editedBy(editing.macro)}
            busy={busy}
            onDepartmentChange={setDepartment}
            onDiscard={() => {
              setEditing(null);
            }}
            onSubmit={(draft) => {
              const saved = editing.macro;
              if (saved === null) {
                create.mutate(draft, {
                  onSuccess: (created) => {
                    open({ key: created.id, macro: created, draft: draftOf(created) });
                  },
                });
                return;
              }
              update.mutate(
                { macro: saved, draft },
                {
                  onSuccess: (updated) => {
                    open({
                      key: `${updated.id}-${updated.updatedAt}`,
                      macro: updated,
                      draft: draftOf(updated),
                    });
                  },
                },
              );
            }}
            {...(editing.macro === null
              ? {}
              : {
                  onDuplicate: () => {
                    const source = editing.macro;
                    if (source !== null) {
                      open({
                        key: `copy-${source.id}-${Date.now()}`,
                        macro: null,
                        draft: duplicateOf(
                          draftOf(source),
                          t('macros:editor.copyName', { name: source.name }),
                        ),
                      });
                    }
                  },
                  onDelete: () => {
                    setConfirming(editing.macro);
                  },
                })}
          />
        )}
      </Box>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('macros:confirm.title', { name: confirming?.name ?? '' })}
        body={t('macros:confirm.body')}
        confirmLabel={t('macros:confirm.submit')}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) {
            remove.mutate(confirming, {
              onSuccess: () => {
                setEditing(null);
              },
            });
          }
          setConfirming(null);
        }}
      />
    </Box>
  );
}

/** "Macro · 3 actions · EN AR", as the artboard's second line under each name. */
const rowCaption = (row: Macro, t: ReturnType<typeof useT>): string => {
  const parts = [t(`macros:kind.${row.kind}`)];
  if (row.kind === 'macro') {
    parts.push(t('macros:list.actionCount', { count: row.actions.length }));
  }
  const en = row.bodies.en.trim() !== '';
  const ar = row.bodies.ar.trim() !== '';
  parts.push(
    !en
      ? t('macros:list.noReply')
      : ar
        ? t('macros:list.bothLanguages')
        : t('macros:list.englishOnly'),
  );

  return parts.join(' · ');
};
