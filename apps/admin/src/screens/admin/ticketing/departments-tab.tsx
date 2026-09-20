import type { DepartmentSummary, EligibleMember, Team } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Building2,
  EllipsisVertical,
  GripVertical,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { isAuthError } from '../../../auth/api.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { isTicketingError } from '../../../ticketing/api.js';
import { refusalCopy } from '../../../ticketing/refusal-copy.js';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { type DepartmentDraft, DepartmentEditor } from './department-editor.tsx';
import { DepartmentTeams } from './department-teams.tsx';
import { moveBy, moveTo } from './reorder.js';

/**
 * The Departments tab of `Admin/Ticketing`: the 820 px list on the start side,
 * the 300 px editor card on the end side, and the selected department's teams
 * inline underneath.
 *
 * **Every mutation invalidates rather than patching.** A rename changes the
 * chip picker on the staff screen, a delete takes its teams with it, and a
 * reorder is a whole list — so what comes back from the server is the only
 * thing worth drawing.
 *
 * **A refusal is a toast, not a banner.** The five rules that answer no — a
 * department you do not lead, the last one, one tickets still point at, a name
 * already taken, somebody who cannot reach it — are about the action, and the
 * page behind the toast is still correct.
 *
 * **Reordering has two ways in and one path out.** The drag handle and the
 * "Move up" / "Move down" row actions both build the same list through
 * `reorder.ts` and send it whole, so the keyboard route cannot drift from the
 * pointer one (DESIGN §10: everything reachable by Tab).
 */
export function DepartmentsTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();

  const brand = currentBrand(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<{
    department: DepartmentSummary;
    anchor: HTMLElement;
  } | null>(null);
  const [confirming, setConfirming] = useState<
    { kind: 'department'; department: DepartmentSummary } | { kind: 'team'; team: Team } | null
  >(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => api.departments(brand.id),
  });

  const rows = departments.data?.departments ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const teams = useQuery({
    queryKey: ['teams', brand.id, selected?.id],
    queryFn: () => api.teams(brand.id, selected?.id ?? ''),
    enabled: selected !== null,
  });

  const eligible = useQuery({
    queryKey: ['eligible-members', brand.id, selected?.id],
    queryFn: () => api.eligibleMembers(brand.id, selected?.id ?? ''),
    enabled: selected !== null,
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['departments', brand.id] }),
      queryClient.invalidateQueries({ queryKey: ['teams', brand.id] }),
    ]);
  };

  const report = (error: unknown): void => {
    if (isTicketingError(error)) {
      toast({ tone: 'danger', message: t(refusalCopy(error.reason)) });
      return;
    }

    toast({
      tone: 'danger',
      message: isAuthError(error) ? t('auth:unavailable') : t('ticketing:toast.failed'),
    });
  };

  const create = useTicketingAction(
    (draft: DepartmentDraft) =>
      api.createDepartment(brand.id, { name: draft.name, nameAr: draft.nameAr }),
    (draft) => t('ticketing:toast.departmentCreated', { name: draft.name }),
    refresh,
    report,
  );

  const update = useTicketingAction(
    (input: { department: DepartmentSummary; draft: DepartmentDraft }) =>
      api.updateDepartment(brand.id, input.department.id, input.draft),
    (input) => t('ticketing:toast.departmentUpdated', { name: input.draft.name }),
    refresh,
    report,
  );

  const remove = useTicketingAction(
    (department: DepartmentSummary) => api.deleteDepartment(brand.id, department.id),
    (department) => t('ticketing:toast.departmentDeleted', { name: department.name }),
    refresh,
    report,
  );

  const reorder = useTicketingAction(
    (order: readonly string[]) => api.reorderDepartments(brand.id, [...order]),
    () => t('ticketing:toast.reordered'),
    refresh,
    report,
  );

  const createTeam = useTicketingAction(
    (input: { departmentId: string; name: string }) =>
      api.createTeam(brand.id, input.departmentId, input.name),
    (input) => t('ticketing:toast.teamCreated', { name: input.name }),
    refresh,
    report,
  );

  const renameTeam = useTicketingAction(
    (input: { departmentId: string; team: Team; name: string }) =>
      api.renameTeam(brand.id, input.departmentId, input.team.id, input.name),
    (input) => t('ticketing:toast.teamRenamed', { name: input.name }),
    refresh,
    report,
  );

  const deleteTeam = useTicketingAction(
    (input: { departmentId: string; team: Team }) =>
      api.deleteTeam(brand.id, input.departmentId, input.team.id),
    (input) => t('ticketing:toast.teamDeleted', { name: input.team.name }),
    refresh,
    report,
  );

  const addMember = useTicketingAction(
    (input: { departmentId: string; team: Team; member: { userId: string; name: string } }) =>
      api.addMember(brand.id, input.departmentId, input.team.id, input.member.userId),
    (input) => t('ticketing:toast.memberAdded', { name: input.member.name, team: input.team.name }),
    refresh,
    report,
  );

  const removeMember = useTicketingAction(
    (input: { departmentId: string; team: Team; member: { userId: string; name: string } }) =>
      api.removeMember(brand.id, input.departmentId, input.team.id, input.member.userId),
    (input) =>
      t('ticketing:toast.memberRemoved', { name: input.member.name, team: input.team.name }),
    refresh,
    report,
  );

  const busy = [
    create,
    update,
    remove,
    reorder,
    createTeam,
    renameTeam,
    deleteTeam,
    addMember,
    removeMember,
  ].some((mutation) => mutation.isPending);

  const order = rows.map((row) => row.id);

  const applyOrder = (next: readonly string[]): void => {
    if (next !== order) {
      reorder.mutate(next);
    }
  };

  const teamsOfSelected: readonly Team[] = teams.data?.teams ?? [];
  const eligibleMembers: readonly EligibleMember[] = eligible.data?.members ?? [];

  const confirmCopy = (): { title: string; body: string; confirmLabel: string } => {
    if (confirming?.kind === 'team') {
      return {
        title: t('ticketing:departments.teams.confirm.delete.title', {
          name: confirming.team.name,
        }),
        body: t('ticketing:departments.teams.confirm.delete.body'),
        confirmLabel: t('ticketing:departments.teams.confirm.delete.submit'),
      };
    }

    return {
      title: t('ticketing:departments.confirm.delete.title', {
        name: confirming?.department.name ?? '',
      }),
      body: t('ticketing:departments.confirm.delete.body'),
      confirmLabel: t('ticketing:departments.confirm.delete.submit'),
    };
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      <Box sx={{ flex: '1 1 520px', maxWidth: 820, minWidth: 0 }}>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', marginBlockEnd: 4 }}>
          <Button
            variant="contained"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            {t('ticketing:departments.add')}
          </Button>
        </Box>

        {rows.length === 0 && !departments.isPending ? (
          <EmptyState
            icon={Building2}
            heading={t('ticketing:departments.empty.heading')}
            body={t('ticketing:departments.empty.body')}
          />
        ) : (
          <TableContainer
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Table aria-label={t('ticketing:departments.table.caption', { brand: brand.name })}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell />
                  <TableCell>{t('ticketing:departments.table.name')}</TableCell>
                  <TableCell>{t('ticketing:departments.table.teams')}</TableCell>
                  <TableCell>{t('ticketing:departments.table.members')}</TableCell>
                  <TableCell>{t('ticketing:departments.table.defaultTeam')}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((department) => (
                  <TableRow
                    key={department.id}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={() => {
                      if (dragging !== null && dragging !== department.id) {
                        applyOrder(moveTo(order, dragging, order.indexOf(department.id)));
                      }
                      setDragging(null);
                    }}
                    sx={{
                      height: 44,
                      backgroundColor:
                        department.id === selectedId ? tokens['action.primary.tint'] : undefined,
                    }}
                  >
                    <TableCell sx={{ width: 40 }}>
                      <IconButton
                        aria-label={t('ticketing:departments.table.dragHandle', {
                          name: department.name,
                        })}
                        draggable
                        disabled={busy}
                        onDragStart={() => {
                          setDragging(department.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            applyOrder(
                              moveBy(order, department.id, event.key === 'ArrowUp' ? -1 : 1),
                            );
                          }
                        }}
                      >
                        <GripVertical size={16} aria-hidden="true" />
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="text"
                        aria-label={t('ticketing:departments.table.select', {
                          name: department.name,
                        })}
                        onClick={() => {
                          setCreating(false);
                          setSelectedId(department.id);
                        }}
                        sx={{ justifyContent: 'flex-start', paddingInline: 0 }}
                      >
                        {department.name}
                      </Button>
                      {department.nameAr === null ? null : (
                        <Typography
                          variant="caption"
                          component="span"
                          lang="ar"
                          dir="rtl"
                          sx={{ display: 'block', color: 'text.secondary' }}
                        >
                          {department.nameAr}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{department.teamCount}</TableCell>
                    <TableCell>{department.memberCount}</TableCell>
                    <TableCell>
                      {department.defaultTeamName ?? t('ticketing:departments.noDefaultTeam')}
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        aria-label={t('ticketing:departments.table.rowActions', {
                          name: department.name,
                        })}
                        aria-haspopup="menu"
                        disabled={busy}
                        onClick={(event) => {
                          setMenuFor({ department, anchor: event.currentTarget });
                        }}
                      >
                        <EllipsisVertical size={16} aria-hidden="true" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {selected === null ? null : (
          <DepartmentTeams
            department={selected}
            teams={teamsOfSelected}
            eligible={eligibleMembers}
            busy={busy}
            onCreate={(name) => {
              createTeam.mutate({ departmentId: selected.id, name });
            }}
            onRename={(team, name) => {
              renameTeam.mutate({ departmentId: selected.id, team, name });
            }}
            onDelete={(team) => {
              setConfirming({ kind: 'team', team });
            }}
            onAddMember={(team, userId) => {
              const member = eligibleMembers.find((candidate) => candidate.userId === userId);
              if (member !== undefined) {
                addMember.mutate({ departmentId: selected.id, team, member });
              }
            }}
            onRemoveMember={(team, member) => {
              removeMember.mutate({ departmentId: selected.id, team, member });
            }}
          />
        )}
      </Box>

      <Box sx={{ flex: '0 0 300px', maxWidth: 300 }}>
        {creating || selected !== null ? (
          <DepartmentEditor
            department={selected}
            teams={teamsOfSelected}
            busy={busy}
            onSubmit={(draft) => {
              if (selected === null) {
                create.mutate(draft, {
                  onSuccess: (created) => {
                    setCreating(false);
                    setSelectedId(created.id);
                  },
                });
                return;
              }

              update.mutate({ department: selected, draft });
            }}
            onCancel={() => {
              setCreating(false);
              setSelectedId(null);
            }}
            {...(selected === null
              ? {}
              : {
                  onDelete: () => {
                    setConfirming({ kind: 'department', department: selected });
                  },
                })}
          />
        ) : (
          <EmptyState
            icon={Pencil}
            heading={t('ticketing:departments.editor.nothing.heading')}
            body={t('ticketing:departments.editor.nothing.body')}
          />
        )}
      </Box>

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('ticketing:departments.table.rowActions', {
              name: menuFor?.department.name ?? '',
            }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setCreating(false);
              setSelectedId(menuFor.department.id);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:departments.actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              applyOrder(moveBy(order, menuFor.department.id, -1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowUp size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:departments.actions.moveUp')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              applyOrder(moveBy(order, menuFor.department.id, 1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowDown size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:departments.actions.moveDown')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setConfirming({ kind: 'department', department: menuFor.department });
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:departments.actions.delete')}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        {...confirmCopy()}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming?.kind === 'department') {
            remove.mutate(confirming.department, {
              onSuccess: () => {
                setSelectedId(null);
              },
            });
          } else if (confirming?.kind === 'team' && selected !== null) {
            deleteTeam.mutate({ departmentId: selected.id, team: confirming.team });
          }
          setConfirming(null);
        }}
      />
    </Box>
  );
}

/**
 * One mutation, wired the same way every time: invalidate what the server just
 * changed, then say so in a toast, and turn a refusal into the sentence its
 * code names. The same shape as `useStaffAction` on the staff screen, because
 * these two screens answer failures identically.
 */
function useTicketingAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  message: (input: TInput) => string,
  refresh: () => Promise<void>,
  report: (error: unknown) => void,
) {
  const toast = useToast();

  return useMutation({
    mutationFn: run,
    onSuccess: async (_result: TResult, input: TInput) => {
      await refresh();
      toast({ tone: 'success', message: message(input) });
    },
    onError: report,
  });
}
