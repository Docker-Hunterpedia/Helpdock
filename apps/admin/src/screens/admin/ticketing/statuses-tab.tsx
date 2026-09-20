import type { ReopenPolicy, TicketStatus } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
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
  Check,
  EllipsisVertical,
  GripVertical,
  Pencil,
  Star,
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
import { moveBy, moveTo } from './reorder.js';
import { ReplyBehaviourCard } from './reply-behaviour-card.tsx';
import { type StatusDraft, StatusEditor } from './status-editor.tsx';

/**
 * The Statuses tab of `Admin/Ticketing`: the brand's statuses, the side editor,
 * and the Reply behaviour card underneath (M1-08).
 *
 * It is built the same way the Departments tab is, and deliberately so — the
 * two tabs are one screen and a person moving between them should not have to
 * learn a second set of gestures:
 *
 * - **every mutation invalidates rather than patching**, because a status
 *   change moves tickets and the server's answer is the only one worth drawing;
 * - **a refusal is a toast**, picked from the shared code-to-copy map, so the
 *   page behind it is still correct;
 * - **reordering has three ways in and one path out** — the drag handle, `↑`/`↓`
 *   on that handle, and the row menu — all through `reorder.ts`, so the
 *   keyboard route cannot drift from the pointer one (DESIGN §10).
 *
 * The **delete confirmation asks the server first**. "Delete · 12 tickets move
 * to Open" is a promise about other people's work, and a count guessed in the
 * browser would be a promise the browser cannot keep.
 */
export function StatusesTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();

  const brand = currentBrand(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<{ status: TicketStatus; anchor: HTMLElement } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<TicketStatus | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const statuses = useQuery({
    queryKey: ['ticket-statuses', brand.id],
    queryFn: () => api.statuses(brand.id),
  });

  const brandQuery = useQuery({
    queryKey: ['brand', brand.id],
    queryFn: () => api.brand(brand.id),
  });

  const rows = statuses.data?.statuses ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  // Only for a status the person could actually delete: the count is a query
  // per selection, and a seeded row has no delete link to print it on.
  const removable = selected !== null && !selected.isSystem && !selected.isDefault;
  const usage = useQuery({
    queryKey: ['ticket-status-usage', brand.id, selected?.id],
    queryFn: () => api.statusUsage(brand.id, selected?.id ?? ''),
    enabled: removable,
    // A Team Leader is refused the count, and is refused the delete for the
    // same reason; retrying would only be refused again.
    retry: false,
  });

  /**
   * The delete link appears only once the server has answered the count.
   *
   * That is not only about having a number to print: the count and the delete
   * are both `brand:manage`, so a person who cannot read one cannot perform the
   * other, and the affordance disappears for exactly the right people without
   * the screen having to know anybody's role.
   */
  const deletable = removable && usage.data !== undefined;

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ticket-statuses', brand.id] }),
      queryClient.invalidateQueries({ queryKey: ['ticket-status-usage', brand.id] }),
      queryClient.invalidateQueries({ queryKey: ['brand', brand.id] }),
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

  const create = useStatusAction(
    (draft: StatusDraft) =>
      api.createStatus(brand.id, {
        name: draft.name,
        nameAr: draft.nameAr,
        systemState: draft.systemState,
        pausesSla: draft.pausesSla,
        awaitingCustomer: draft.awaitingCustomer,
        color: draft.color,
      }),
    (draft) => t('ticketing:toast.statusCreated', { name: draft.name }),
    refresh,
    report,
  );

  const update = useStatusAction(
    (input: { status: TicketStatus; draft: StatusDraft }) =>
      api.updateStatus(brand.id, input.status.id, input.draft),
    (input) => t('ticketing:toast.statusUpdated', { name: input.draft.name }),
    refresh,
    report,
  );

  const makeDefault = useStatusAction(
    (status: TicketStatus) => api.updateStatus(brand.id, status.id, { isDefault: true }),
    (status) => t('ticketing:toast.statusUpdated', { name: status.name }),
    refresh,
    report,
  );

  const remove = useStatusAction(
    (status: TicketStatus) => api.deleteStatus(brand.id, status.id),
    (status) => t('ticketing:toast.statusDeleted', { name: status.name }),
    refresh,
    report,
  );

  const reorder = useStatusAction(
    (order: readonly string[]) => api.reorderStatuses(brand.id, [...order]),
    () => t('ticketing:toast.statusesReordered'),
    refresh,
    report,
  );

  const replyBehaviour = useStatusAction(
    (next: { autoAwaitOnAgentReply: boolean; reopenPolicy: ReopenPolicy }) =>
      api.updateReplyBehaviour(brand.id, next),
    () => t('ticketing:toast.replyBehaviourSaved'),
    refresh,
    report,
  );

  const busy = [create, update, makeDefault, remove, reorder, replyBehaviour].some(
    (mutation) => mutation.isPending,
  );

  const order = rows.map((row) => row.id);

  const applyOrder = (next: readonly string[]): void => {
    if (next !== order) {
      reorder.mutate(next);
    }
  };

  const fallbackName = usage.data?.fallbackName ?? '';
  const ticketCount = usage.data?.ticketCount ?? 0;

  return (
    <Box>
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
              {t('ticketing:statuses.add')}
            </Button>
          </Box>

          <TableContainer
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Table aria-label={t('ticketing:statuses.table.caption', { brand: brand.name })}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell />
                  <TableCell>{t('ticketing:statuses.table.name')}</TableCell>
                  <TableCell>{t('ticketing:statuses.table.systemState')}</TableCell>
                  <TableCell>{t('ticketing:statuses.table.pausesSla')}</TableCell>
                  <TableCell>{t('ticketing:statuses.table.awaitingCustomer')}</TableCell>
                  <TableCell align="right">{t('ticketing:statuses.table.tickets')}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((status) => (
                  <TableRow
                    key={status.id}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={() => {
                      if (dragging !== null && dragging !== status.id) {
                        applyOrder(moveTo(order, dragging, order.indexOf(status.id)));
                      }
                      setDragging(null);
                    }}
                    sx={{
                      height: 44,
                      backgroundColor:
                        status.id === selectedId ? tokens['action.primary.tint'] : undefined,
                    }}
                  >
                    <TableCell sx={{ width: 40 }}>
                      <IconButton
                        aria-label={t('ticketing:statuses.table.dragHandle', { name: status.name })}
                        draggable
                        disabled={busy}
                        onDragStart={() => {
                          setDragging(status.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            applyOrder(moveBy(order, status.id, event.key === 'ArrowUp' ? -1 : 1));
                          }
                        }}
                      >
                        <GripVertical size={16} aria-hidden="true" />
                      </IconButton>
                    </TableCell>

                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Box
                          aria-hidden="true"
                          sx={{
                            inlineSize: 10,
                            blockSize: 10,
                            borderRadius: '50%',
                            flexShrink: 0,
                            backgroundColor: tokens[`status.${status.color}`],
                          }}
                        />
                        <Button
                          variant="text"
                          aria-label={t('ticketing:statuses.table.select', { name: status.name })}
                          onClick={() => {
                            setCreating(false);
                            setSelectedId(status.id);
                          }}
                          sx={{ justifyContent: 'flex-start', paddingInline: 0 }}
                        >
                          {status.name}
                        </Button>
                        <Chip
                          size="small"
                          label={t(
                            status.isDefault
                              ? 'ticketing:statuses.chips.default'
                              : status.isSystem
                                ? 'ticketing:statuses.chips.system'
                                : 'ticketing:statuses.chips.custom',
                          )}
                        />
                      </Box>
                      {status.nameAr === null ? null : (
                        <Typography
                          variant="caption"
                          component="span"
                          lang="ar"
                          dir="rtl"
                          sx={{ display: 'block', color: 'text.secondary' }}
                        >
                          {status.nameAr}
                        </Typography>
                      )}
                    </TableCell>

                    <TableCell>{t(`ticketing:statuses.states.${status.systemState}`)}</TableCell>
                    <TableCell>
                      <FlagCell on={status.pausesSla} />
                    </TableCell>
                    <TableCell>
                      <FlagCell on={status.awaitingCustomer} />
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {status.id === selected?.id && usage.data !== undefined
                        ? usage.data.ticketCount
                        : ''}
                    </TableCell>

                    <TableCell align="right">
                      <IconButton
                        aria-label={t('ticketing:statuses.table.rowActions', { name: status.name })}
                        aria-haspopup="menu"
                        disabled={busy}
                        onClick={(event) => {
                          setMenuFor({ status, anchor: event.currentTarget });
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

          {brandQuery.data === undefined ? null : (
            <ReplyBehaviourCard
              settings={brandQuery.data.settings}
              busy={busy}
              onSave={(next) => {
                replyBehaviour.mutate(next);
              }}
            />
          )}
        </Box>

        <Box sx={{ flex: '0 0 300px', maxWidth: 300 }}>
          {creating || selected !== null ? (
            <StatusEditor
              status={selected}
              ticketCount={ticketCount}
              fallbackName={fallbackName}
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

                update.mutate({ status: selected, draft });
              }}
              onCancel={() => {
                setCreating(false);
                setSelectedId(null);
              }}
              {...(deletable && selected !== null
                ? {
                    onDelete: () => {
                      setConfirming(selected);
                    },
                  }
                : {})}
            />
          ) : (
            <EmptyState
              icon={Pencil}
              heading={t('ticketing:statuses.editor.nothing.heading')}
              body={t('ticketing:statuses.editor.nothing.body')}
            />
          )}
        </Box>
      </Box>

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('ticketing:statuses.table.rowActions', {
              name: menuFor?.status.name ?? '',
            }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setCreating(false);
              setSelectedId(menuFor.status.id);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:statuses.actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              applyOrder(moveBy(order, menuFor.status.id, -1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowUp size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:statuses.actions.moveUp')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              applyOrder(moveBy(order, menuFor.status.id, 1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowDown size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:statuses.actions.moveDown')}
        </MenuItem>
        <MenuItem
          disabled={menuFor?.status.systemState !== 'open' || menuFor.status.isDefault}
          onClick={() => {
            if (menuFor !== null) {
              makeDefault.mutate(menuFor.status);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Star size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:statuses.actions.makeDefault')}
        </MenuItem>
        <MenuItem
          disabled={menuFor?.status.isSystem !== false || menuFor.status.isDefault}
          onClick={() => {
            if (menuFor !== null) {
              setSelectedId(menuFor.status.id);
              setConfirming(menuFor.status);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:statuses.actions.delete')}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('ticketing:statuses.confirm.delete.title', { name: confirming?.name ?? '' })}
        body={t('ticketing:statuses.confirm.delete.body', {
          count: ticketCount,
          fallback: fallbackName,
        })}
        confirmLabel={t('ticketing:statuses.confirm.delete.submit')}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) {
            remove.mutate(confirming, {
              onSuccess: () => {
                setSelectedId(null);
              },
            });
          }
          setConfirming(null);
        }}
      />
    </Box>
  );
}

/**
 * A flag column. A tick with a readable name rather than a bare icon, because a
 * screen reader hearing "image" in five consecutive cells learns nothing, and
 * an empty cell is the honest rendering of "no".
 */
function FlagCell({ on }: { readonly on: boolean }): ReactNode {
  const t = useT();

  return on ? (
    <>
      <Check size={16} aria-hidden="true" />
      <Box
        component="span"
        sx={{
          position: 'absolute',
          inlineSize: 1,
          blockSize: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
        }}
      >
        {t('ticketing:statuses.table.checked')}
      </Box>
    </>
  ) : null;
}

/**
 * One mutation, wired the same way every time: invalidate what the server just
 * changed, then say so in a toast, and turn a refusal into the sentence its code
 * names. The same shape `departments-tab.tsx` uses, because the two tabs answer
 * failures identically.
 */
function useStatusAction<TInput, TResult>(
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
