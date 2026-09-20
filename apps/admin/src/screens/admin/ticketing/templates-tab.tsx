import type { TicketTemplate, TicketTemplatePreview } from '@helpdock/schemas';
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
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EllipsisVertical, FileText, Pencil, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { type TemplateDraft, TemplateEditor } from './template-editor.tsx';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/**
 * The Templates tab of `Admin/Ticketing`: the list on the start side, the
 * editor card on the end side, the same shape as the other three tabs.
 *
 * There is no reorder here. A template is chosen from a picker by name, not
 * read as an ordered list, so an order would be a control with nothing behind
 * it.
 */
export function TemplatesTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();

  const brand = currentBrand(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<{
    template: TicketTemplate;
    anchor: HTMLElement;
  } | null>(null);
  const [confirming, setConfirming] = useState<TicketTemplate | null>(null);
  const [preview, setPreview] = useState<TicketTemplatePreview | null>(null);

  const templates = useQuery({
    queryKey: ['ticket-templates', brand.id],
    queryFn: () => api.ticketTemplates(brand.id),
  });
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => api.departments(brand.id),
  });
  const tags = useQuery({ queryKey: ['tags', brand.id], queryFn: () => api.tags(brand.id) });
  const fields = useQuery({
    queryKey: ['custom-fields', brand.id],
    queryFn: () => api.customFields(brand.id),
  });

  const rows = templates.data?.templates ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const departmentRows = departments.data?.departments ?? [];
  const ticketFields = (fields.data?.fields ?? []).filter((field) => field.target === 'ticket');

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['ticket-templates', brand.id] });
  };

  const create = useTicketingAction(
    (draft: TemplateDraft) =>
      api.createTicketTemplate(brand.id, {
        ...draft,
        defaultTagIds: [...draft.defaultTagIds],
      }),
    (draft) => t('ticketing:toast.templateCreated', { name: draft.name }),
    refresh,
    report,
  );

  const update = useTicketingAction(
    (input: { template: TicketTemplate; draft: TemplateDraft }) =>
      api.updateTicketTemplate(brand.id, input.template.id, {
        ...input.draft,
        defaultTagIds: [...input.draft.defaultTagIds],
      }),
    (input) => t('ticketing:toast.templateUpdated', { name: input.draft.name }),
    refresh,
    report,
  );

  const remove = useTicketingAction(
    (template: TicketTemplate) => api.deleteTicketTemplate(brand.id, template.id),
    (template) => t('ticketing:toast.templateDeleted', { name: template.name }),
    refresh,
    report,
  );

  const busy = [create, update, remove].some((mutation) => mutation.isPending);

  const departmentName = (id: string | null): string =>
    departmentRows.find((row) => row.id === id)?.name ?? t('ticketing:templates.anyDepartment');

  const showPreview = (template: TicketTemplate): void => {
    api.previewTicketTemplate(brand.id, template.id).then(setPreview, report);
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
              setPreview(null);
            }}
          >
            {t('ticketing:templates.add')}
          </Button>
        </Box>

        {rows.length === 0 && !templates.isPending ? (
          <EmptyState
            icon={FileText}
            heading={t('ticketing:templates.empty.heading')}
            body={t('ticketing:templates.empty.body')}
          />
        ) : (
          <TableContainer
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            <Table aria-label={t('ticketing:templates.table.caption', { brand: brand.name })}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell>{t('ticketing:templates.table.name')}</TableCell>
                  <TableCell>{t('ticketing:templates.table.department')}</TableCell>
                  <TableCell>{t('ticketing:templates.table.priority')}</TableCell>
                  <TableCell>{t('ticketing:templates.table.usage')}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((template) => (
                  <TableRow
                    key={template.id}
                    sx={{
                      height: 44,
                      backgroundColor:
                        template.id === selectedId ? tokens['action.primary.tint'] : undefined,
                    }}
                  >
                    <TableCell>
                      <Button
                        variant="text"
                        aria-label={t('ticketing:templates.table.select', { name: template.name })}
                        onClick={() => {
                          setCreating(false);
                          setSelectedId(template.id);
                          setPreview(null);
                        }}
                        sx={{ justifyContent: 'flex-start', paddingInline: 0 }}
                      >
                        {template.name}
                      </Button>
                    </TableCell>
                    <TableCell>{departmentName(template.departmentId)}</TableCell>
                    <TableCell>
                      {t(`ticketing:templates.priorities.${template.priority}`)}
                    </TableCell>
                    <TableCell>{template.usageCount}</TableCell>
                    <TableCell align="right">
                      <IconButton
                        aria-label={t('ticketing:templates.table.rowActions', {
                          name: template.name,
                        })}
                        aria-haspopup="menu"
                        disabled={busy}
                        onClick={(event) => {
                          setMenuFor({ template, anchor: event.currentTarget });
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
          <TemplateEditor
            template={selected}
            departments={departmentRows}
            tags={tags.data?.tags ?? []}
            ticketFields={ticketFields}
            preview={preview}
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

              update.mutate({ template: selected, draft });
            }}
            onCancel={() => {
              setCreating(false);
              setSelectedId(null);
              setPreview(null);
            }}
            onPreview={() => {
              if (selected !== null) {
                showPreview(selected);
              }
            }}
            onClosePreview={() => {
              setPreview(null);
            }}
            {...(selected === null
              ? {}
              : {
                  onDelete: () => {
                    setConfirming(selected);
                  },
                })}
          />
        ) : (
          <EmptyState
            icon={Pencil}
            heading={t('ticketing:templates.editor.nothing.heading')}
            body={t('ticketing:templates.editor.nothing.body')}
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
            'aria-label': t('ticketing:templates.table.rowActions', {
              name: menuFor?.template.name ?? '',
            }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setCreating(false);
              setSelectedId(menuFor.template.id);
              setPreview(null);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:templates.actions.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setConfirming(menuFor.template);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:templates.actions.delete')}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('ticketing:templates.confirm.delete.title', { name: confirming?.name ?? '' })}
        body={t('ticketing:templates.confirm.delete.body')}
        confirmLabel={t('ticketing:templates.confirm.delete.submit')}
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
