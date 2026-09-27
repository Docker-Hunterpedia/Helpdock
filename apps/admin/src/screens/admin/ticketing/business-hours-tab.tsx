import type { BusinessHours, HolidayCreateRequest } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Repeat } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { DepartmentHoursCard } from './department-hours.tsx';
import { HolidaysCard } from './holidays-card.tsx';
import {
  copyFirstDayToOpenDays,
  type DraftProblem,
  draftOf,
  type HoursDraft,
  problemOf,
  requestOf,
  sameDraft,
  WEEKDAY_KEYS,
} from './hours-draft.js';
import { TimeZoneSelect } from './time-zone-select.tsx';
import { useTicketingAction, useTicketingReport } from './use-ticketing-action.js';
import { WeekEditor } from './week-editor.tsx';

/**
 * The Business hours tab of `Admin/Ticketing` (M3-01, artboard
 * `Admin/Ticketing-BusinessHours`): the brand's zone and week, its holidays,
 * and each department's override.
 *
 * The zone, the week and the overrides are one draft with one Save, because
 * the api recomputes every open ticket's due times on a save and a save per
 * click would recompute them per click. Holidays are saved as they are added
 * or deleted: each is one fact with nothing to discard.
 *
 * Nothing here decides who may change what. A Team Leader who changes the
 * brand's own hours is refused by the api (DOMAIN-RULES §1.2) and told so in
 * a toast, as every other tab of this screen does.
 */
export function BusinessHoursTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const toast = useToast();
  const { locale } = usePreferences();
  const brand = currentBrand(session);
  const queryKey = ['business-hours', brand.id];

  const overview = useQuery({ queryKey, queryFn: () => api.businessHours(brand.id) });
  const [draft, setDraft] = useState<HoursDraft | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (overview.data !== undefined) {
      setDraft(draftOf(overview.data));
    }
  }, [overview.data]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const save = useTicketingAction(
    (next: HoursDraft) => api.updateBusinessHours(brand.id, requestOf(next)),
    () => t('ticketing:toast.businessHoursSaved'),
    refresh,
    report,
  );
  const addHoliday = useMutation({
    mutationFn: (request: HolidayCreateRequest) => api.createHoliday(brand.id, request),
    onSuccess: async (holiday) => {
      await refresh();
      toast({
        tone: 'success',
        message: t('ticketing:toast.holidayAdded', { name: holiday.name }),
      });
    },
    onError: report,
  });
  const deleteHoliday = useTicketingAction(
    ({ holidayId }: { holidayId: string; name: string }) => api.deleteHoliday(brand.id, holidayId),
    ({ name }) => t('ticketing:toast.holidayDeleted', { name }),
    refresh,
    report,
  );

  if (overview.data === undefined || draft === null) {
    return <Box aria-busy="true" />;
  }

  const stored = draftOf(overview.data);
  const changed = !sameDraft(draft, stored);
  const problem = problemOf(draft);
  const setBrand = (next: BusinessHours): void => {
    setDraft({ ...draft, brand: next });
  };
  const departmentName = (departmentId: string | null): string => {
    if (departmentId === null) {
      return t('ticketing:businessHours.footer.brand');
    }
    const row = overview.data.departments.find((entry) => entry.departmentId === departmentId);
    return (locale === 'ar' ? row?.nameAr : null) ?? row?.name ?? '';
  };

  const card = {
    borderRadius: '10px',
    border: `1px solid ${tokens['border.default']}`,
    backgroundColor: tokens['bg.surface'],
  } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBlockEnd: 20 }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box
          component="section"
          aria-labelledby="business-hours-heading"
          sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <Box>
            <Typography variant="h3" component="h2" id="business-hours-heading">
              {t('ticketing:businessHours.heading')}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('ticketing:businessHours.caption')}
            </Typography>
          </Box>

          <Box sx={{ ...card, padding: 4 }}>
            <TimeZoneSelect
              label={t('ticketing:businessHours.timezone.label')}
              helperText={t('ticketing:businessHours.timezone.hint')}
              value={draft.brand.timezone}
              onChange={(timezone) => {
                setBrand({ ...draft.brand, timezone });
              }}
            />
          </Box>

          <Box component="section" aria-labelledby="weekly-heading" sx={card}>
            <Box sx={{ padding: 4, display: 'flex', gap: 2, alignItems: 'flex-start' }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="bodyStrong" component="h3" id="weekly-heading">
                  {t('ticketing:businessHours.weekly.heading')}
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {t('ticketing:businessHours.weekly.caption')}
                </Typography>
              </Box>
              <Button
                variant="outlined"
                size="small"
                startIcon={<Repeat size={14} aria-hidden="true" />}
                disabled={(draft.brand.weekly[0] ?? []).length === 0}
                onClick={() => {
                  setBrand({ ...draft.brand, weekly: copyFirstDayToOpenDays(draft.brand.weekly) });
                }}
              >
                {t('ticketing:businessHours.weekly.copy')}
              </Button>
            </Box>
            <WeekEditor
              weekly={draft.brand.weekly}
              onChange={(weekly) => {
                setBrand({ ...draft.brand, weekly });
              }}
            />
          </Box>

          <HolidaysCard
            overview={overview.data}
            today={new Date().toISOString().slice(0, 10)}
            busy={addHoliday.isPending || deleteHoliday.isPending}
            onAdd={async (request) => {
              await addHoliday.mutateAsync(request);
            }}
            onDelete={(holidayId, name) => {
              deleteHoliday.mutate({ holidayId, name });
            }}
          />
        </Box>

        <DepartmentHoursCard
          departments={overview.data.departments}
          overrides={draft.overrides}
          brand={draft.brand}
          expanded={expanded}
          onExpand={setExpanded}
          onChange={(departmentId, override) => {
            setDraft({ ...draft, overrides: { ...draft.overrides, [departmentId]: override } });
          }}
        />
      </Box>

      <Box
        role="region"
        aria-label={t('ticketing:businessHours.footer.label')}
        sx={{
          position: 'sticky',
          insetBlockEnd: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          paddingBlock: 3,
          paddingInline: 4,
          borderBlockStart: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
        }}
      >
        <Info size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        <Typography variant="body2" aria-live="polite" sx={{ flex: 1, color: 'text.secondary' }}>
          {footerText(problem, departmentName, t, overview.data.runningTickets)}
        </Typography>
        <Button
          variant="text"
          disabled={!changed || save.isPending}
          onClick={() => {
            setDraft(stored);
          }}
        >
          {t('ticketing:businessHours.footer.discard')}
        </Button>
        <Button
          variant="contained"
          disabled={!changed || problem !== null || save.isPending}
          onClick={() => {
            save.mutate(draft);
          }}
        >
          {t('ticketing:businessHours.footer.save')}
        </Button>
      </Box>
    </Box>
  );
}

const footerText = (
  problem: DraftProblem | null,
  place: (departmentId: string | null) => string,
  t: ReturnType<typeof useT>,
  count: number,
): string => {
  const recompute = t('ticketing:businessHours.footer.recompute', { count });
  if (problem === null) {
    return recompute;
  }
  if (problem.kind === 'closed') {
    return `${t('ticketing:businessHours.footer.closed', { place: place(problem.departmentId) })} ${recompute}`;
  }
  const day = t(`ticketing:businessHours.days.${WEEKDAY_KEYS[problem.day] ?? 'sunday'}`);
  return `${t('ticketing:businessHours.footer.fixRange', { day, place: place(problem.departmentId) })} ${recompute}`;
};
