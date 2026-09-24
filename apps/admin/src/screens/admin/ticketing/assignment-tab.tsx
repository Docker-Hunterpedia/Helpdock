import type {
  AssignmentAgent,
  AssignmentAgentUpdateRequest,
  DepartmentAssignment,
  DepartmentAssignmentUpdateRequest,
} from '@helpdock/schemas';
import {
  Box,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Pencil, Route } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { AssignmentAgents } from './assignment-agents.tsx';
import { AssignmentEditor } from './assignment-editor.tsx';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/**
 * The Assignment tab of `Admin/Ticketing` (artboard
 * `Admin/Ticketing-Assignment`, M1-07): one row per department the viewer
 * leads, the agents of the selected one below it, and the settings card on the
 * inline-end side.
 *
 * The first department is selected on arrival, as the artboard draws it,
 * because the agents list is half of what the tab is for and an empty space
 * under the table would be the first thing anybody saw.
 */

const nameIn = (
  department: Pick<DepartmentAssignment, 'name' | 'nameAr'>,
  locale: 'en' | 'ar',
): string => (locale === 'ar' && department.nameAr !== null ? department.nameAr : department.name);

export function AssignmentTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const queryClient = useQueryClient();
  const report = useTicketingReport();

  const brand = currentBrand(session);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const departments = useQuery({
    queryKey: ['assignment', brand.id],
    queryFn: () => api.assignment(brand.id),
  });
  const rows = departments.data?.departments ?? [];
  const selected = rows.find((row) => row.departmentId === selectedId) ?? rows[0] ?? null;

  const agents = useQuery({
    queryKey: ['assignment', brand.id, 'agents', selected?.departmentId],
    queryFn: () => api.assignmentAgents(brand.id, selected?.departmentId ?? ''),
    enabled: selected !== null,
  });
  const tags = useQuery({ queryKey: ['tags', brand.id], queryFn: () => api.tags(brand.id) });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['assignment', brand.id] });
  };

  const save = useTicketingAction(
    (input: { department: DepartmentAssignment; request: DepartmentAssignmentUpdateRequest }) =>
      api.updateAssignment(brand.id, input.department.departmentId, input.request),
    (input) => t('ticketing:toast.assignmentSaved', { name: nameIn(input.department, locale) }),
    refresh,
    report,
  );

  const changeAgent = useTicketingAction(
    (input: { agent: AssignmentAgent; request: AssignmentAgentUpdateRequest }) =>
      api.updateAssignmentAgent(
        brand.id,
        selected?.departmentId ?? '',
        input.agent.userId,
        input.request,
      ),
    (input) => t('ticketing:toast.agentUpdated', { name: input.agent.name }),
    refresh,
    report,
  );

  const busy = save.isPending || changeAgent.isPending;

  if (rows.length === 0 && !departments.isPending) {
    return (
      <EmptyState
        icon={Route}
        heading={t('ticketing:assignment.empty.heading')}
        body={t('ticketing:assignment.empty.body')}
      />
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      <Box
        sx={{
          flex: '1 1 560px',
          maxWidth: 920,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Box>
          <Typography variant="h3" component="h2">
            {t('ticketing:assignment.heading')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:assignment.caption')}
          </Typography>
        </Box>

        <TableContainer
          sx={{
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
          }}
        >
          <Table aria-label={t('ticketing:assignment.table.caption', { brand: brand.name })}>
            <TableHead>
              <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                <TableCell>{t('ticketing:assignment.table.department')}</TableCell>
                <TableCell>{t('ticketing:assignment.table.mode')}</TableCell>
                <TableCell align="right">{t('ticketing:assignment.table.loadCap')}</TableCell>
                <TableCell>{t('ticketing:assignment.table.autoUnassign')}</TableCell>
                <TableCell align="right">{t('ticketing:assignment.table.agentsOnline')}</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((department) => {
                const name = nameIn(department, locale);
                const current = department.departmentId === selected?.departmentId;

                return (
                  <TableRow
                    key={department.departmentId}
                    aria-selected={current}
                    sx={{
                      height: 48,
                      backgroundColor: current ? tokens['action.primary.tint'] : undefined,
                    }}
                  >
                    {/* DESIGN §6.3's selected edge, on the inline-start side in both directions. */}
                    <TableCell
                      sx={{
                        borderInlineStart: `3px solid ${current ? tokens['action.primary'] : 'transparent'}`,
                      }}
                    >
                      <Typography variant="bodyStrong" component="span">
                        {name}
                      </Typography>
                    </TableCell>
                    <TableCell>{t(`ticketing:assignment.modes.${department.mode}`)}</TableCell>
                    <TableCell align="right">
                      <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
                        {department.loadCap === null
                          ? t('ticketing:assignment.table.noCap')
                          : department.loadCap}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {department.autoUnassignOffline ? (
                        t('ticketing:assignment.table.minutes', {
                          minutes: department.autoUnassignAfterMinutes,
                        })
                      ) : (
                        <Typography
                          variant="body2"
                          component="span"
                          sx={{ color: 'text.secondary' }}
                        >
                          {t('ticketing:assignment.table.off')}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
                        {t('ticketing:assignment.table.online', {
                          online: department.agentsOnline,
                          total: department.agentsInRotation,
                        })}
                      </Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ width: 40 }}>
                      <IconButton
                        aria-label={t('ticketing:assignment.table.edit', { name })}
                        aria-pressed={current}
                        disabled={busy}
                        onClick={() => {
                          setSelectedId(department.departmentId);
                        }}
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>

        {selected === null ? null : (
          <AssignmentAgents
            departmentName={nameIn(selected, locale)}
            loadCap={agents.data?.loadCap ?? selected.loadCap}
            agents={agents.data?.agents ?? []}
            tags={tags.data?.tags ?? []}
            busy={busy}
            onChange={(agent, request) => {
              changeAgent.mutate({ agent, request });
            }}
          />
        )}
      </Box>

      <Box
        component="aside"
        sx={{ flex: '0 0 300px', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        {selected === null ? (
          <EmptyState
            icon={Pencil}
            heading={t('ticketing:assignment.editor.nothing.heading')}
            body={t('ticketing:assignment.editor.nothing.body')}
          />
        ) : (
          <AssignmentEditor
            department={selected}
            departmentName={nameIn(selected, locale)}
            busy={busy}
            onSubmit={(request) => {
              save.mutate({ department: selected, request });
            }}
          />
        )}

        <Box
          sx={{
            display: 'flex',
            gap: 2,
            padding: 4,
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
            color: 'text.secondary',
          }}
        >
          <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
          <Typography variant="body2">{t('ticketing:assignment.note')}</Typography>
        </Box>
      </Box>
    </Box>
  );
}
