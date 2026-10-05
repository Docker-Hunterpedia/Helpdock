import type { RetentionUpdateRequest, SessionBrand } from '@helpdock/schemas';
import { Box, Tab, Tabs, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { brandRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { isAuthError } from '../../../auth/api.js';
import { currentBrand, useSession, useTicketingApi } from '../../../auth/session.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { DeleteBrandCard, PendingDeletionBanner, useBrandDeletion } from './brand-deletion.tsx';
import { DomainsTab } from './domains-tab.tsx';
import { GeneralTab } from './general-tab.tsx';
import { RetentionCard } from './retention-card.tsx';

/**
 * `Admin/Brand`: **General** (artboard `AdminBrand`, the Identity card),
 * **Domains** (`AdminBrandDomains`, M5-07) and **Danger zone**
 * (`AdminBrandDanger`: M1-14's Data retention card and M8-07's "Delete this
 * brand").
 *
 * There is no Theme tab: theming lives on Channels › Widget and on the help
 * center's own settings. While the brand is in its deletion grace every tab
 * shows the banner with Restore and is read-only: the brand is on its way out,
 * and a change made now would be purged or restored with it unseen.
 */

const BRAND_TABS = [
  { key: 'general', segment: 'general' },
  { key: 'domains', segment: 'domains' },
  { key: 'danger', segment: 'danger' },
] as const;
const DEFAULT_BRAND_TAB = BRAND_TABS[0];

export function BrandPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();
  const deletion = useBrandDeletion(brand.id, session.user.installAdmin);
  const pending = deletion.data?.status === 'deleting';

  const tab = BRAND_TABS.find((candidate) => candidate.segment === segment);
  if (tab === undefined) {
    return <Navigate to={brandRoute(DEFAULT_BRAND_TAB.segment)} replace />;
  }

  return (
    <>
      <PageHeader title={t('brand:title')} caption={t('brand:subtitle', { brand: brand.name })} />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs
          value={tab.key}
          aria-label={t('brand:tabList')}
          slotProps={{
            indicator: {
              sx: tab.key === 'danger' ? { backgroundColor: tokens['status.danger'] } : {},
            },
          }}
        >
          {BRAND_TABS.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`brand:tabs.${candidate.key}`)}
              component={Link}
              to={brandRoute(candidate.segment)}
              sx={
                candidate.key === 'danger'
                  ? { '&.Mui-selected': { color: tokens['status.danger.text'] } }
                  : {}
              }
            />
          ))}
        </Tabs>
      </Box>

      {deletion.data === undefined ? null : (
        <PendingDeletionBanner brand={brand} deletion={deletion.data} />
      )}

      {/* A disabled fieldset turns every control under it off at once, which
          is what read-only during the grace means. */}
      <Box
        component="fieldset"
        disabled={pending}
        sx={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
      >
        {tab.key === 'general' ? <GeneralTab /> : null}
        {tab.key === 'domains' ? <DomainsTab /> : null}
        {tab.key === 'danger' ? (
          <DangerZone brand={brand} installAdmin={session.user.installAdmin} pending={pending} />
        ) : null}
      </Box>
    </>
  );
}

function DangerZone({
  brand,
  installAdmin,
  pending,
}: {
  readonly brand: SessionBrand;
  readonly installAdmin: boolean;
  /** In its deletion grace: there is nothing to delete, and the banner offers Restore. */
  readonly pending: boolean;
}): ReactNode {
  const t = useT();
  const brandId = brand.id;
  const api = useTicketingApi();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();

  const retention = useQuery({
    queryKey: ['retention', brandId],
    queryFn: () => api.retention(brandId),
  });

  const save = useMutation({
    mutationFn: (request: RetentionUpdateRequest) => api.updateRetention(brandId, request),
    onSuccess: (overview) => {
      queryClient.setQueryData(['retention', brandId], overview);
      toast({ tone: 'success', message: t('brand:retention.saved') });
    },
    onError: (error) => {
      toast({
        tone: 'danger',
        message: isAuthError(error) ? t('auth:unavailable') : t('brand:retention.failed'),
      });
    },
  });

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 720px) 300px' },
        gap: 8,
        alignContent: 'start',
      }}
    >
      <Box sx={{ display: 'grid', gap: 6, alignContent: 'start' }}>
        {retention.isError ? (
          <AlertBanner tone="danger">{t('brand:retention.loadFailed')}</AlertBanner>
        ) : null}
        {retention.data === undefined ? null : (
          <RetentionCard
            overview={retention.data}
            busy={save.isPending}
            onSave={(request) => {
              save.mutate(request);
            }}
          />
        )}
        {pending ? null : <DeleteBrandCard brand={brand} installAdmin={installAdmin} />}
      </Box>

      <Box
        component="aside"
        aria-labelledby="erasure-heading"
        sx={{
          alignSelf: 'start',
          paddingBlock: '14px',
          paddingInline: 4,
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography id="erasure-heading" component="h2" sx={{ fontSize: 13, fontWeight: 600 }}>
          {t('brand:erasure.heading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('brand:erasure.body')}
        </Typography>
      </Box>
    </Box>
  );
}
