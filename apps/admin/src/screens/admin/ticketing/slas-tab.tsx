import type { BrandSettings, SlaPolicy, SlaPolicyCreateRequest } from '@helpdock/schemas';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useStaffApi, useTicketingApi } from '../../../auth/session.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { moveBy, moveTo } from './reorder.js';
import type { PickOptions } from './sla-action-picker.tsx';
import {
  draftOfPolicy,
  issuesOf,
  newPolicyDraft,
  type PolicyDraft,
  requestOfDraft,
  sameDraft,
  uncovered,
} from './sla-draft.js';
import { SlaPolicyEditor } from './sla-policy-editor.tsx';
import { SlaSettingsCard } from './sla-settings-card.tsx';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';

/** The editor's subject: a stored policy, or one being written. */
type Selection = { readonly kind: 'policy'; readonly id: string } | { readonly kind: 'new' };

/**
 * The SLAs tab of `Admin/Ticketing` (M3-02, artboard `Admin/Ticketing-SLAs`):
 * the policies in the order they are tried, the settings that apply to all of
 * them, and the editor for the one selected.
 *
 * The order is changed by dragging a policy's handle or with the arrow keys on
 * it, and saved at once, because it decides which policy every ticket runs
 * under. The editor saves on its own Save, which recomputes the clocks of the
 * tickets it covers on the api (DOMAIN-RULES §3.3).
 */
export function SlasTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const staffApi = useStaffApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const { locale } = usePreferences();
  const brand = currentBrand(session);
  const policiesKey = ['sla-policies', brand.id];

  const policies = useQuery({ queryKey: policiesKey, queryFn: () => api.slaPolicies(brand.id) });
  const brandQuery = useQuery({
    queryKey: ['brand', brand.id],
    queryFn: () => api.brand(brand.id),
  });
  const statuses = useQuery({
    queryKey: ['ticket-statuses', brand.id],
    queryFn: () => api.statuses(brand.id),
  });
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => api.departments(brand.id),
  });
  const tags = useQuery({ queryKey: ['tags', brand.id], queryFn: () => api.tags(brand.id) });
  const staff = useQuery({
    queryKey: ['staff', brand.id],
    queryFn: () => staffApi.listStaff(brand.id),
  });
  const teams = useQueries({
    queries: (departments.data?.departments ?? []).map((department) => ({
      queryKey: ['teams', brand.id, department.id],
      queryFn: () => api.teams(brand.id, department.id),
    })),
  });

  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [deleting, setDeleting] = useState<SlaPolicy | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const ordered = policies.data?.policies ?? [];
  const selected =
    selection?.kind === 'policy' ? ordered.find((policy) => policy.id === selection.id) : undefined;

  // The first policy is open when the tab opens, as the artboard draws it.
  useEffect(() => {
    if (selection === null && ordered[0] !== undefined) {
      setSelection({ kind: 'policy', id: ordered[0].id });
    }
  }, [selection, ordered]);

  useEffect(() => {
    if (selected !== undefined) {
      setDraft(draftOfPolicy(selected));
      setTried(false);
    }
  }, [selected]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: policiesKey });
  };

  const create = useMutation({
    mutationFn: (request: SlaPolicyCreateRequest) => api.createSlaPolicy(brand.id, request),
    onSuccess: async (policy) => {
      await refresh();
      setSelection({ kind: 'policy', id: policy.id });
    },
    onError: report,
  });
  const update = useTicketingAction(
    ({ id, request }: { id: string; request: SlaPolicyCreateRequest }) =>
      api.updateSlaPolicy(brand.id, id, request),
    ({ request }) => t('ticketing:toast.policySaved', { name: request.name }),
    refresh,
    report,
  );
  const remove = useTicketingAction(
    (policy: SlaPolicy) => api.deleteSlaPolicy(brand.id, policy.id),
    (policy) => t('ticketing:toast.policyDeleted', { name: policy.name }),
    async () => {
      setDeleting(null);
      setSelection(null);
      await refresh();
    },
    report,
  );
  const reorder = useTicketingAction(
    (ids: readonly string[]) => api.reorderSlaPolicies(brand.id, [...ids]),
    () => t('ticketing:toast.policiesReordered'),
    refresh,
    report,
  );
  const settings = useTicketingAction(
    (patch: Pick<Partial<BrandSettings>, 'aiCountsAsFirstResponse' | 'slaCountReopens'>) =>
      api.updateSlaSettings(brand.id, patch),
    () => t('ticketing:toast.slaSettingsSaved'),
    async () => {
      await queryClient.invalidateQueries({ queryKey: ['brand', brand.id] });
    },
    report,
  );

  const departmentName = (id: string): string => {
    const row = departments.data?.departments.find((department) => department.id === id);
    return (locale === 'ar' ? row?.nameAr : null) ?? row?.name ?? '';
  };

  const options: PickOptions = useMemo(
    () => ({
      departments: (departments.data?.departments ?? []).map((department) => ({
        id: department.id,
        name: (locale === 'ar' ? department.nameAr : null) ?? department.name,
      })),
      people: (staff.data?.staff ?? [])
        .filter((member) => member.status === 'active')
        .map((member) => ({ id: member.userId, name: member.name })),
      teams: teams.flatMap((query) =>
        (query.data?.teams ?? []).map((team) => ({ id: team.id, name: team.name })),
      ),
      tags: (tags.data?.tags ?? []).map((tag) => ({
        id: tag.id,
        name: (locale === 'ar' ? tag.nameAr : null) ?? tag.name,
      })),
    }),
    [departments.data, staff.data, teams, tags.data, locale],
  );

  if (policies.data === undefined || brandQuery.data === undefined) {
    return <Box aria-busy="true" />;
  }

  const order = ordered.map((policy) => policy.id);
  const applyOrder = (next: readonly string[]): void => {
    if (next !== order) {
      reorder.mutate(next);
    }
  };
  const gaps = uncovered(
    ordered,
    (departments.data?.departments ?? []).map((department) => department.id),
  );
  const baseline =
    selection?.kind === 'new'
      ? newPolicyDraft(draft?.name ?? '')
      : selected === undefined
        ? null
        : draftOfPolicy(selected);
  const issues = draft === null ? null : issuesOf(draft);

  const save = (): void => {
    if (draft === null) {
      return;
    }
    setTried(true);
    const request = requestOfDraft(draft);
    if (request === null) {
      return;
    }
    if (selection?.kind === 'new') {
      create.mutate(request);
    } else if (selected !== undefined) {
      update.mutate({ id: selected.id, request });
    }
  };

  const summary = (policy: SlaPolicy): string =>
    policy.conditions.length === 0
      ? t('ticketing:slas.list.everyTicket')
      : policy.conditions
          .map((condition) =>
            t(
              condition.operator === 'any'
                ? `ticketing:slas.list.${condition.field}Any`
                : `ticketing:slas.list.${condition.field}None`,
              {
                values: condition.values
                  .map((value) =>
                    condition.field === 'department'
                      ? departmentName(value)
                      : t(`tickets:priority.${value as 'low'}`),
                  )
                  .join(t('ticketing:slas.list.or')),
              },
            ),
          )
          .join(' · ');

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', lg: '340px minmax(0, 1fr)' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h3" component="h2">
              {t('ticketing:slas.list.heading')}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('ticketing:slas.list.caption')}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Plus size={16} aria-hidden="true" />}
            onClick={() => {
              setSelection({ kind: 'new' });
              setDraft(newPolicyDraft(''));
              setTried(false);
            }}
          >
            {t('ticketing:slas.list.new')}
          </Button>
        </Box>

        <Box
          sx={{
            borderRadius: '10px',
            border: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.surface'],
            overflow: 'hidden',
          }}
        >
          {ordered.length === 0 ? (
            <Typography variant="body2" sx={{ padding: 4, color: 'text.secondary' }}>
              {t('ticketing:slas.list.empty')}
            </Typography>
          ) : (
            <Box
              component="ol"
              aria-label={t('ticketing:slas.list.heading')}
              sx={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {ordered.map((policy, index) => {
                const current = selection?.kind === 'policy' && selection.id === policy.id;
                return (
                  <Box
                    component="li"
                    key={policy.id}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={() => {
                      if (dragging !== null && dragging !== policy.id) {
                        applyOrder(moveTo(order, dragging, index));
                      }
                      setDragging(null);
                    }}
                    sx={{
                      display: 'flex',
                      gap: 1,
                      paddingBlock: 3,
                      paddingInline: 2,
                      borderBlockStart: index === 0 ? 0 : `1px solid ${tokens['border.default']}`,
                      borderInlineStart: `3px solid ${current ? tokens['action.primary'] : 'transparent'}`,
                      backgroundColor: current ? tokens['action.primary.tint'] : undefined,
                    }}
                  >
                    <IconButton
                      size="small"
                      draggable
                      disabled={reorder.isPending}
                      aria-label={t('ticketing:slas.list.dragHandle', { name: policy.name })}
                      onDragStart={() => {
                        setDragging(policy.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          applyOrder(moveBy(order, policy.id, event.key === 'ArrowUp' ? -1 : 1));
                        }
                      }}
                      sx={{ alignSelf: 'flex-start' }}
                    >
                      <GripVertical size={16} aria-hidden="true" />
                    </IconButton>
                    <Box sx={{ flex: 1, minInlineSize: 0 }}>
                      <Button
                        variant="text"
                        aria-current={current ? 'true' : undefined}
                        onClick={() => {
                          setSelection({ kind: 'policy', id: policy.id });
                        }}
                        sx={{
                          paddingInline: 0,
                          justifyContent: 'flex-start',
                          color: 'text.primary',
                          gap: 2,
                        }}
                      >
                        <Typography
                          component="span"
                          variant="mono"
                          sx={{ color: 'text.secondary' }}
                        >
                          {index + 1}
                        </Typography>
                        {policy.name}
                      </Button>
                      <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
                        {summary(policy)}
                      </Typography>
                      <Typography
                        variant="caption"
                        component="span"
                        sx={{
                          display: 'inline-block',
                          marginBlockStart: 1,
                          paddingInline: 1.5,
                          borderRadius: '6px',
                          backgroundColor: tokens['bg.muted'],
                          color: 'text.secondary',
                        }}
                      >
                        {t(`ticketing:slas.list.${policy.timeMode}`)}
                      </Typography>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
          <Typography
            variant="caption"
            component="p"
            sx={{
              paddingBlock: 2,
              paddingInline: 3,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              color: 'text.secondary',
            }}
          >
            {t('ticketing:slas.list.unmatched')}{' '}
            {gaps.length === 0
              ? t('ticketing:slas.list.allCovered')
              : t('ticketing:slas.list.gaps', {
                  gaps: gaps
                    .slice(0, 3)
                    .map((gap) =>
                      t('ticketing:slas.list.gap', {
                        department: departmentName(gap.departmentId),
                        priority: t(`tickets:priority.${gap.priority}`),
                      }),
                    )
                    .join(t('ticketing:slas.list.and')),
                })}
          </Typography>
        </Box>

        <SlaSettingsCard
          settings={brandQuery.data.settings}
          statuses={statuses.data?.statuses ?? []}
          busy={settings.isPending}
          onChange={(patch) => {
            settings.mutate(patch);
          }}
        />
      </Box>

      {draft === null || issues === null || baseline === null ? (
        <Box />
      ) : (
        <SlaPolicyEditor
          draft={draft}
          // A missing name is said once somebody tries to save; a target of 0 as
          // soon as it is typed, as the artboard draws it.
          issues={tried ? issues : { ...issues, name: false }}
          showIssues
          caption={
            selected === undefined
              ? null
              : t('ticketing:slas.editor.caption', {
                  position: selected.position + 1,
                  total: ordered.length,
                  name: selected.updatedBy?.name ?? t('ticketing:slas.editor.someone'),
                  date: new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  }).format(new Date(selected.updatedAt)),
                })
          }
          runningTickets={selected?.runningTickets ?? 0}
          options={options}
          busy={create.isPending || update.isPending || remove.isPending}
          changed={selection?.kind === 'new' || !sameDraft(draft, baseline)}
          onChange={setDraft}
          onDelete={
            selected === undefined
              ? null
              : () => {
                  setDeleting(selected);
                }
          }
          onDiscard={() => {
            if (selection?.kind === 'new') {
              setSelection(null);
              setDraft(null);
            } else {
              setDraft(baseline);
            }
            setTried(false);
          }}
          onSave={save}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('ticketing:slas.delete.title', { name: deleting?.name ?? '' })}
        body={t('ticketing:slas.delete.body', { count: deleting?.runningTickets ?? 0 })}
        confirmLabel={t('ticketing:slas.delete.confirm')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </Box>
  );
}
