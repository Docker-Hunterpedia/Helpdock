import type { TagSummary } from '@helpdock/schemas';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  GripVertical,
  Pencil,
  Tag,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { moveBy, moveTo } from './reorder.js';
import { TagChip } from './tag-chip.tsx';
import { type TagDraft, TagEditor } from './tag-editor.tsx';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/**
 * The Tags tab of `Admin/Ticketing`, built from the same artboard pattern the
 * Departments tab is: the list on the start side, the 300 px editor card on the
 * end side.
 *
 * **Deleting is never refused, so the confirmation has to be honest.** A tag
 * detaches from the tickets that carried it; nothing stops it. The dialog reads
 * the count from the api first and says how many tickets keep no tag, because
 * the decision is the person's and they cannot make it blind.
 *
 * **Reordering has the same two ways in and one path out** as the Departments
 * tab: the drag handle, `↑`/`↓` on it, and the row menu all build one list
 * through `reorder.ts` and send it whole.
 */
export function TagsTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();

  const brand = currentBrand(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<{ tag: TagSummary; anchor: HTMLElement } | null>(null);
  const [confirming, setConfirming] = useState<{ tag: TagSummary; ticketCount: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState<string | null>(null);

  const tags = useQuery({ queryKey: ['tags', brand.id], queryFn: () => api.tags(brand.id) });

  const rows = tags.data?.tags ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const order = rows.map((row) => row.id);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['tags', brand.id] });
  };

  const create = useTicketingAction(
    (draft: TagDraft) => api.createTag(brand.id, draft),
    (draft) => t('ticketing:toast.tagCreated', { name: draft.name }),
    refresh,
    report,
  );

  const update = useTicketingAction(
    (input: { tag: TagSummary; draft: TagDraft }) =>
      api.updateTag(brand.id, input.tag.id, input.draft),
    (input) => t('ticketing:toast.tagUpdated', { name: input.draft.name }),
    refresh,
    report,
  );

  const remove = useTicketingAction(
    (tag: TagSummary) => api.deleteTag(brand.id, tag.id),
    (tag) => t('ticketing:toast.tagDeleted', { name: tag.name }),
    refresh,
    report,
  );

  const reorder = useTicketingAction(
    (next: readonly string[]) => api.reorderTags(brand.id, [...next]),
    () => t('ticketing:toast.tagsReordered'),
    refresh,
    report,
  );

  const busy = [create, update, remove, reorder].some((mutation) => mutation.isPending);

  const applyOrder = (next: readonly string[]): void => {
    if (next !== order) {
      reorder.mutate(next);
    }
  };

  /**
   * Reads the live count before asking. The list row carries one too, but it is
   * as old as the last refetch, and this sentence is the only thing the person
   * has to go on — so a read that fails says so rather than asking with a
   * number nobody checked.
   */
  const askToDelete = (tag: TagSummary): void => {
    api.tagUsage(brand.id, tag.id).then((usage) => {
      setConfirming({ tag, ticketCount: usage.ticketCount });
    }, report);
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
            {t('ticketing:tags.add')}
          </Button>
        </Box>

        {rows.length === 0 && !tags.isPending ? (
          <EmptyState
            icon={Tag}
            heading={t('ticketing:tags.empty.heading')}
            body={t('ticketing:tags.empty.body')}
          />
        ) : (
          <TableContainer
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Table aria-label={t('ticketing:tags.table.caption', { brand: brand.name })}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell />
                  <TableCell>{t('ticketing:tags.table.colour')}</TableCell>
                  <TableCell>{t('ticketing:tags.table.name')}</TableCell>
                  <TableCell>{t('ticketing:tags.table.nameAr')}</TableCell>
                  <TableCell>{t('ticketing:tags.table.tickets')}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((tag) => (
                  <TableRow
                    key={tag.id}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={() => {
                      if (dragging !== null && dragging !== tag.id) {
                        applyOrder(moveTo(order, dragging, order.indexOf(tag.id)));
                      }
                      setDragging(null);
                    }}
                    sx={{
                      height: 44,
                      backgroundColor:
                        tag.id === selectedId ? tokens['action.primary.tint'] : undefined,
                    }}
                  >
                    <TableCell sx={{ width: 40 }}>
                      <IconButton
                        aria-label={t('ticketing:tags.table.dragHandle', { name: tag.name })}
                        draggable
                        disabled={busy}
                        onDragStart={() => {
                          setDragging(tag.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            applyOrder(moveBy(order, tag.id, event.key === 'ArrowUp' ? -1 : 1));
                          }
                        }}
                      >
                        <GripVertical size={16} aria-hidden="true" />
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <TagChip tag={tag} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="text"
                        aria-label={t('ticketing:tags.table.select', { name: tag.name })}
                        onClick={() => {
                          setCreating(false);
                          setSelectedId(tag.id);
                        }}
                        sx={{ justifyContent: 'flex-start', paddingInline: 0 }}
                      >
                        {tag.name}
                      </Button>
                    </TableCell>
                    <TableCell>
                      {tag.nameAr === null ? null : (
                        <Typography
                          variant="caption"
                          component="span"
                          lang="ar"
                          dir="rtl"
                          sx={{ color: 'text.secondary' }}
                        >
                          {tag.nameAr}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{tag.ticketCount}</TableCell>
                    <TableCell align="right">
                      <IconButton
                        aria-label={t('ticketing:tags.table.rowActions', { name: tag.name })}
                        aria-haspopup="menu"
                        disabled={busy}
                        onClick={(event) => {
                          setMenuFor({ tag, anchor: event.currentTarget });
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
      </Box>

      <Box sx={{ flex: '0 0 300px', maxWidth: 300 }}>
        {creating || selected !== null ? (
          <TagEditor
            tag={selected}
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

              update.mutate({ tag: selected, draft });
            }}
            onCancel={() => {
              setCreating(false);
              setSelectedId(null);
            }}
            {...(selected === null
              ? {}
              : {
                  onDelete: () => {
                    askToDelete(selected);
                  },
                })}
          />
        ) : (
          <EmptyState
            icon={Pencil}
            heading={t('ticketing:tags.editor.nothing.heading')}
            body={t('ticketing:tags.editor.nothing.body')}
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
            'aria-label': t('ticketing:tags.table.rowActions', { name: menuFor?.tag.name ?? '' }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setCreating(false);
              setSelectedId(menuFor.tag.id);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:tags.actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              applyOrder(moveBy(order, menuFor.tag.id, -1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowUp size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:tags.actions.moveUp')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              applyOrder(moveBy(order, menuFor.tag.id, 1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowDown size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:tags.actions.moveDown')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              askToDelete(menuFor.tag);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:tags.actions.delete')}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('ticketing:tags.confirm.delete.title', { name: confirming?.tag.name ?? '' })}
        body={t('ticketing:tags.confirm.delete.body', { count: confirming?.ticketCount ?? 0 })}
        confirmLabel={t('ticketing:tags.confirm.delete.submit')}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) {
            remove.mutate(confirming.tag, {
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
