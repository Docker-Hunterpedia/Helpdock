import type { CustomFieldDef, CustomFieldTarget } from '@helpdock/schemas';
import { customFieldTargetSchema } from '@helpdock/schemas';
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
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { isTicketingError } from '../../../ticketing/api.js';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { type CustomFieldDraft, CustomFieldEditor } from './custom-field-editor.tsx';
import { moveBy, moveTo } from './reorder.js';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/**
 * The Custom fields tab of `Admin/Ticketing`. One table per target — Ticket,
 * Contact, Account — because the three are separate lists with separate orders
 * and a single table would need a column nobody sorts by to say which is which.
 *
 * The editor card is shared by all three, so the person edits in one place
 * whichever group they came from.
 *
 * **An option removal is asked about, not refused silently.** The api answers
 * `option-in-use` when rows still carry one of the options being dropped; the
 * dialog explains that saving clears it from them, and a second send carries
 * `force`.
 */
export function CustomFieldsTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();

  const brand = currentBrand(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<CustomFieldTarget | null>(null);
  const [menuFor, setMenuFor] = useState<{ field: CustomFieldDef; anchor: HTMLElement } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<{ field: CustomFieldDef; rows: number } | null>(
    null,
  );
  const [forcing, setForcing] = useState<{ field: CustomFieldDef; draft: CustomFieldDraft } | null>(
    null,
  );
  const [dragging, setDragging] = useState<string | null>(null);

  const fields = useQuery({
    queryKey: ['custom-fields', brand.id],
    queryFn: () => api.customFields(brand.id),
  });

  const rows = fields.data?.fields ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['custom-fields', brand.id] });
  };

  const create = useTicketingAction(
    (draft: CustomFieldDraft) =>
      api.createCustomField(brand.id, { ...draft, options: [...draft.options] }),
    (draft) => t('ticketing:toast.fieldCreated', { name: draft.label }),
    refresh,
    report,
  );

  const update = useTicketingAction(
    (input: { field: CustomFieldDef; draft: CustomFieldDraft; force?: boolean }) =>
      api.updateCustomField(brand.id, input.field.id, {
        label: input.draft.label,
        labelAr: input.draft.labelAr,
        type: input.draft.type,
        options: [...input.draft.options],
        required: input.draft.required,
        agentVisible: input.draft.agentVisible,
        force: input.force ?? false,
      }),
    (input) => t('ticketing:toast.fieldUpdated', { name: input.draft.label }),
    refresh,
    report,
  );

  const remove = useTicketingAction(
    (field: CustomFieldDef) => api.deleteCustomField(brand.id, field.id),
    (field) => t('ticketing:toast.fieldDeleted', { name: field.label }),
    refresh,
    report,
  );

  const reorder = useTicketingAction(
    (input: { target: CustomFieldTarget; fieldIds: readonly string[] }) =>
      api.reorderCustomFields(brand.id, input.target, [...input.fieldIds]),
    () => t('ticketing:toast.fieldsReordered'),
    refresh,
    report,
  );

  const busy = [create, update, remove, reorder].some((mutation) => mutation.isPending);

  const applyOrder = (target: CustomFieldTarget, next: readonly string[]): void => {
    reorder.mutate({ target, fieldIds: next });
  };

  /** The live count, because the confirmation is the only thing the person has. */
  const askToDelete = (field: CustomFieldDef): void => {
    api.customFieldUsage(brand.id, field.id).then((usage) => {
      setConfirming({ field, rows: usage.rows });
    }, report);
  };

  /**
   * Sends the edit, and — when the api refuses because rows still carry an
   * option being removed — asks instead of giving up. The retry is the same
   * request with `force`.
   */
  const save = (field: CustomFieldDef, draft: CustomFieldDraft): void => {
    update.mutate(
      { field, draft },
      {
        onError: (error: unknown) => {
          if (isOptionInUse(error)) {
            setForcing({ field, draft });
            return;
          }
          report(error);
        },
      },
    );
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      <Box sx={{ flex: '1 1 520px', maxWidth: 820, minWidth: 0, display: 'grid', gap: 6 }}>
        {customFieldTargetSchema.options.map((target) => {
          const ofTarget = rows.filter((row) => row.target === target);
          const order = ofTarget.map((row) => row.id);

          return (
            <Box key={target}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBlockEnd: 4,
                }}
              >
                <Typography variant="h3" component="h2">
                  {t(`ticketing:customFields.targets.${target}`)}
                </Typography>
                <Button
                  variant="contained"
                  onClick={() => {
                    setCreatingIn(target);
                    setSelectedId(null);
                  }}
                >
                  {t('ticketing:customFields.addTo', {
                    target: t(`ticketing:customFields.targets.${target}`).toLocaleLowerCase(),
                  })}
                </Button>
              </Box>

              {ofTarget.length === 0 && !fields.isPending ? (
                <EmptyState
                  icon={SlidersHorizontal}
                  heading={t('ticketing:customFields.empty.heading')}
                  body={t('ticketing:customFields.empty.body')}
                />
              ) : (
                <TableContainer
                  sx={{
                    borderRadius: '10px',
                    border: `1px solid ${tokens['border.default']}`,
                    backgroundColor: tokens['bg.surface'],
                  }}
                >
                  <Table
                    aria-label={t('ticketing:customFields.table.caption', {
                      target: t(`ticketing:customFields.targets.${target}`),
                    })}
                  >
                    <TableHead>
                      <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                        <TableCell />
                        <TableCell>{t('ticketing:customFields.table.label')}</TableCell>
                        <TableCell>{t('ticketing:customFields.table.key')}</TableCell>
                        <TableCell>{t('ticketing:customFields.table.type')}</TableCell>
                        <TableCell>{t('ticketing:customFields.table.required')}</TableCell>
                        <TableCell>{t('ticketing:customFields.table.shownOn')}</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {ofTarget.map((field) => (
                        <TableRow
                          key={field.id}
                          onDragOver={(event) => {
                            event.preventDefault();
                          }}
                          onDrop={() => {
                            if (dragging !== null && dragging !== field.id) {
                              applyOrder(target, moveTo(order, dragging, order.indexOf(field.id)));
                            }
                            setDragging(null);
                          }}
                          sx={{
                            height: 44,
                            backgroundColor:
                              field.id === selectedId ? tokens['action.primary.tint'] : undefined,
                          }}
                        >
                          <TableCell sx={{ width: 40 }}>
                            <IconButton
                              aria-label={t('ticketing:customFields.table.dragHandle', {
                                name: field.label,
                              })}
                              draggable
                              disabled={busy}
                              onDragStart={() => {
                                setDragging(field.id);
                              }}
                              onDragEnd={() => {
                                setDragging(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                  event.preventDefault();
                                  applyOrder(
                                    target,
                                    moveBy(order, field.id, event.key === 'ArrowUp' ? -1 : 1),
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
                              aria-label={t('ticketing:customFields.table.select', {
                                name: field.label,
                              })}
                              onClick={() => {
                                setCreatingIn(null);
                                setSelectedId(field.id);
                              }}
                              sx={{ justifyContent: 'flex-start', paddingInline: 0 }}
                            >
                              {field.label}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <Typography
                              component="code"
                              dir="ltr"
                              sx={{ fontFamily: 'monospace', fontSize: 13 }}
                            >
                              {field.key}
                            </Typography>
                          </TableCell>
                          <TableCell>{t(`ticketing:customFields.types.${field.type}`)}</TableCell>
                          <TableCell>
                            {field.required
                              ? t('ticketing:customFields.yes')
                              : t('ticketing:customFields.no')}
                          </TableCell>
                          <TableCell>
                            {field.agentVisible
                              ? t('ticketing:customFields.shown.agents')
                              : t('ticketing:customFields.shown.adminsOnly')}
                          </TableCell>
                          <TableCell align="right">
                            <IconButton
                              aria-label={t('ticketing:customFields.table.rowActions', {
                                name: field.label,
                              })}
                              aria-haspopup="menu"
                              disabled={busy}
                              onClick={(event) => {
                                setMenuFor({ field, anchor: event.currentTarget });
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
          );
        })}
      </Box>

      <Box sx={{ flex: '0 0 300px', maxWidth: 300 }}>
        {creatingIn !== null || selected !== null ? (
          <CustomFieldEditor
            field={selected}
            target={creatingIn ?? selected?.target ?? 'ticket'}
            busy={busy}
            onSubmit={(draft) => {
              if (selected === null) {
                create.mutate(draft, {
                  onSuccess: (created) => {
                    setCreatingIn(null);
                    setSelectedId(created.id);
                  },
                });
                return;
              }

              save(selected, draft);
            }}
            onCancel={() => {
              setCreatingIn(null);
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
            heading={t('ticketing:customFields.editor.nothing.heading')}
            body={t('ticketing:customFields.editor.nothing.body')}
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
            'aria-label': t('ticketing:customFields.table.rowActions', {
              name: menuFor?.field.label ?? '',
            }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setCreatingIn(null);
              setSelectedId(menuFor.field.id);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:customFields.actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              const order = rows
                .filter((row) => row.target === menuFor.field.target)
                .map((row) => row.id);
              applyOrder(menuFor.field.target, moveBy(order, menuFor.field.id, -1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowUp size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:customFields.actions.moveUp')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              const order = rows
                .filter((row) => row.target === menuFor.field.target)
                .map((row) => row.id);
              applyOrder(menuFor.field.target, moveBy(order, menuFor.field.id, 1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowDown size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:customFields.actions.moveDown')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              askToDelete(menuFor.field);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:customFields.actions.delete')}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('ticketing:customFields.confirm.delete.title', {
          name: confirming?.field.label ?? '',
        })}
        body={t('ticketing:customFields.confirm.delete.body', { count: confirming?.rows ?? 0 })}
        confirmLabel={t('ticketing:customFields.confirm.delete.submit')}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) {
            remove.mutate(confirming.field, {
              onSuccess: () => {
                setSelectedId(null);
              },
            });
          }
          setConfirming(null);
        }}
      />

      <ConfirmDialog
        open={forcing !== null}
        destructive
        busy={busy}
        title={t('ticketing:customFields.confirm.force.title')}
        body={t('ticketing:customFields.confirm.force.body')}
        confirmLabel={t('ticketing:customFields.confirm.force.submit')}
        onClose={() => {
          setForcing(null);
        }}
        onConfirm={() => {
          if (forcing !== null) {
            update.mutate({ field: forcing.field, draft: forcing.draft, force: true });
          }
          setForcing(null);
        }}
      />
    </Box>
  );
}

/** The one refusal this tab answers with a question rather than with a toast. */
const isOptionInUse = (error: unknown): boolean =>
  isTicketingError(error) && error.reason === 'option-in-use';
