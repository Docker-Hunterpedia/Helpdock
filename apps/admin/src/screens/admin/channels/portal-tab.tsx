import type { DepartmentSummary, PortalSettings } from '@helpdock/schemas';
import { monoFontStyle } from '@helpdock/ui';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Link as MuiLink,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { channelsRoute, ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { useDomainsApi } from '../../../domains/context.tsx';
import { useDepartmentsQuery } from '../../../ticketing/use-departments.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { LoadingSkeleton } from '../../../ui/loading-skeleton.tsx';
import { RadioCard } from '../../../ui/radio-card.tsx';
import { Switch } from '../../../ui/switch.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import {
  draftOf,
  hasNoDepartment,
  isChanged,
  type PortalDraft,
  portalAddress,
  requestOf,
  toggled,
} from './portal-draft.js';

/**
 * Channels › Customer portal (M21-06, `Admin/Channels-CustomerPortal`): the
 * portal on or off, whether an address that has no contact yet may sign in
 * (D-63), and which departments' tickets it shows (D-65).
 *
 * One form, one Save: three settings are one decision about what customers can
 * reach, and Discard is meaningless if each saved as it was clicked. A failed
 * save is the banner with the values kept. The save is its own route and
 * replaces `settings.portal` alone, and the api drops the brand's cached help
 * center pages with it, so the header gains or loses its Sign in link at once.
 */
export function PortalTab(): ReactNode {
  const t = useT();
  const api = useTicketingApi();
  const brand = currentBrand(useSession());
  const query = useQuery({
    queryKey: ['brand', brand.id],
    queryFn: () => api.brand(brand.id),
  });
  const departments = useDepartmentsQuery(brand.id);

  if (query.isError || departments.isError) {
    return <AlertBanner tone="danger">{t('channels:portal.loadFailed')}</AlertBanner>;
  }
  if (query.data === undefined || departments.data === undefined) {
    return <LoadingSkeleton />;
  }

  return (
    <PortalForm
      brandId={brand.id}
      stored={query.data.settings.portal}
      departments={departments.data.departments}
    />
  );
}

function PortalForm({
  brandId,
  stored,
  departments,
}: {
  readonly brandId: string;
  readonly stored: PortalSettings;
  readonly departments: readonly DepartmentSummary[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const { locale } = usePreferences();
  const api = useTicketingApi();
  const domains = useDomainsApi();
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<PortalDraft>(() => draftOf(stored));
  const [failed, setFailed] = useState(false);

  // Re-filled when the stored settings change under the form (after a save, or
  // after another tab wrote them), and not on every click.
  useEffect(() => {
    setDraft(draftOf(stored));
  }, [stored]);

  const domainList = useQuery({
    queryKey: ['domains', brandId],
    queryFn: () => domains.domains(brandId),
  });
  const address = portalAddress(domainList.data?.domains ?? [], {
    host: window.location.host,
    brandId,
  });

  const save = useMutation({
    mutationFn: () => api.updatePortalSettings(brandId, requestOf(draft)),
    onSuccess: async () => {
      setFailed(false);
      await queryClient.invalidateQueries({ queryKey: ['brand', brandId] });
      toast({ tone: 'success', message: t('channels:portal.saved') });
    },
    onError: () => {
      setFailed(true);
    },
  });

  const changed = isChanged(draft, stored);
  const noDepartment = hasNoDepartment(draft);
  const set = (patch: Partial<PortalDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (changed && !noDepartment) {
      save.mutate();
    }
  };

  const card = {
    borderRadius: '10px',
    border: `1px solid ${tokens['border.default']}`,
    backgroundColor: tokens['bg.surface'],
  } as const;
  const row = { padding: 5, display: 'flex', gap: 4, alignItems: 'flex-start' } as const;
  const divider = `1px solid ${tokens['border.default']}`;
  const nameOf = (department: DepartmentSummary): string =>
    locale === 'ar' && department.nameAr !== null ? department.nameAr : department.name;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 820 }}>
      {stored.enabled ? null : <AlertBanner tone="info">{t('channels:portal.off')}</AlertBanner>}
      {failed ? <AlertBanner tone="danger">{t('channels:portal.saveFailed')}</AlertBanner> : null}

      <Box
        component="form"
        noValidate
        onSubmit={submit}
        aria-label={t('channels:portal.form')}
        sx={{ ...card, display: 'flex', flexDirection: 'column' }}
      >
        <Box sx={{ ...row, borderBlockEnd: divider }}>
          <Switch
            checked={draft.enabled}
            label={t('channels:portal.enabled')}
            describedBy={`${id}-enabled`}
            onChange={(enabled) => {
              set({ enabled });
            }}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <Typography variant="bodyStrong" component="h2">
              {t('channels:portal.enabled')}
            </Typography>
            <Typography id={`${id}-enabled`} variant="body2" sx={{ color: 'text.secondary' }}>
              {t('channels:portal.enabledHint')}{' '}
              <Box
                component="bdi"
                dir="ltr"
                sx={{ ...monoFontStyle, color: 'text.primary', overflowWrap: 'anywhere' }}
              >
                {address}
              </Box>
              .
            </Typography>
          </Box>
        </Box>

        <Box sx={{ ...row, borderBlockEnd: divider }}>
          <Switch
            checked={draft.newCustomers}
            label={t('channels:portal.newCustomers')}
            describedBy={`${id}-new`}
            onChange={(newCustomers) => {
              set({ newCustomers });
            }}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <Typography variant="bodyStrong" component="h2">
              {t('channels:portal.newCustomers')}
            </Typography>
            <Typography id={`${id}-new`} variant="body2" sx={{ color: 'text.secondary' }}>
              {t('channels:portal.newCustomersHint')}
            </Typography>
          </Box>
        </Box>

        <Box
          component="fieldset"
          sx={{ ...row, flexDirection: 'column', border: 0, margin: 0, minWidth: 0 }}
        >
          <Box component="legend" sx={{ padding: 0, marginBlockEnd: 1 }}>
            <Typography variant="bodyStrong" component="span" sx={{ display: 'block' }}>
              {t('channels:portal.departments')}
            </Typography>
            <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
              {t('channels:portal.departmentsHint')}
            </Typography>
          </Box>
          <RadioCard
            id={`${id}-all`}
            name={`${id}-scope`}
            value="all"
            checked={draft.scope === 'all'}
            title={t('channels:portal.allDepartments')}
            description={t('channels:portal.allDepartmentsHint')}
            onSelect={() => {
              set({ scope: 'all' });
            }}
          />
          <RadioCard
            id={`${id}-only`}
            name={`${id}-scope`}
            value="only"
            checked={draft.scope === 'only'}
            title={t('channels:portal.onlyThese')}
            description={t('channels:portal.onlyTheseHint')}
            onSelect={() => {
              set({ scope: 'only' });
            }}
          />
          {draft.scope === 'only' ? (
            <Box
              role="group"
              aria-label={t('channels:portal.departments')}
              sx={{ display: 'flex', flexDirection: 'column', paddingInlineStart: 6 }}
            >
              {departments.map((department) => (
                <FormControlLabel
                  key={department.id}
                  label={
                    <Box
                      component="span"
                      lang={locale === 'ar' && department.nameAr !== null ? 'ar' : undefined}
                    >
                      {nameOf(department)}
                    </Box>
                  }
                  control={
                    <Checkbox
                      size="small"
                      checked={draft.departmentIds.includes(department.id)}
                      onChange={(event) => {
                        set({
                          departmentIds: toggled(
                            draft.departmentIds,
                            department.id,
                            event.target.checked,
                          ),
                        });
                      }}
                    />
                  }
                />
              ))}
              {noDepartment ? (
                <Typography
                  variant="caption"
                  role="alert"
                  sx={{ color: tokens['status.danger.text'] }}
                >
                  {t('channels:portal.needsOne')}
                </Typography>
              ) : null}
            </Box>
          ) : null}
        </Box>

        <Box
          sx={{
            paddingBlock: 3,
            paddingInline: 5,
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 2,
            borderBlockStart: divider,
            backgroundColor: tokens['bg.canvas'],
            borderEndStartRadius: '10px',
            borderEndEndRadius: '10px',
          }}
        >
          <Button
            variant="text"
            disabled={!changed || save.isPending}
            onClick={() => {
              setDraft(draftOf(stored));
              setFailed(false);
            }}
          >
            {t('channels:discard')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!changed || noDepartment || save.isPending}
          >
            {t('channels:portal.save')}
          </Button>
        </Box>
      </Box>

      <Box component="nav" aria-label={t('channels:portal.related')} sx={{ ...card, padding: 5 }}>
        <Typography variant="bodyStrong" component="h2" sx={{ marginBlockEnd: 2 }}>
          {t('channels:portal.related')}
        </Typography>
        <Box
          component="ul"
          sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}
        >
          <RelatedLink to={ROUTES.contactsAccounts}>
            {t('channels:portal.relatedAccounts')}
          </RelatedLink>
          <RelatedLink to={channelsRoute('outgoing')}>
            {t('channels:portal.relatedEmail')}
          </RelatedLink>
        </Box>
      </Box>
    </Box>
  );
}

function RelatedLink({
  to,
  children,
}: {
  readonly to: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box component="li">
      <MuiLink
        component={Link}
        to={to}
        variant="body2"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
      >
        {children}
        <ArrowRight size={14} aria-hidden="true" className="mirror-in-rtl" />
      </MuiLink>
    </Box>
  );
}
