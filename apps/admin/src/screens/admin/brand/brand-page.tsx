import type { RetentionUpdateRequest } from '@helpdock/schemas';
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
import { RetentionCard } from './retention-card.tsx';

/**
 * `Admin/Brand` (artboard `AdminBrandDanger`), with the one tab M1-14 builds:
 * **Danger zone**, holding the Data retention card.
 *
 * The artboard also draws General, Domains and Theme tabs and a "Delete this
 * brand" section. None of them has a deliverable in M1 — brand deletion is its
 * own path in DOMAIN-RULES §11 — so they are not drawn at all rather than drawn
 * as controls that do nothing. The tab row stays, so the next tab has a place
 * to land.
 */

const BRAND_TABS = [{ key: 'danger', segment: 'danger' }] as const;
const DEFAULT_BRAND_TAB = BRAND_TABS[0];

export function BrandPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const { tab: segment } = useParams();

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
          slotProps={{ indicator: { sx: { backgroundColor: tokens['status.danger'] } } }}
        >
          {BRAND_TABS.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`brand:tabs.${candidate.key}`)}
              component={Link}
              to={brandRoute(candidate.segment)}
              sx={{ '&.Mui-selected': { color: tokens['status.danger.text'] } }}
            />
          ))}
        </Tabs>
      </Box>

      <DangerZone brandId={brand.id} />
    </>
  );
}

function DangerZone({ brandId }: { readonly brandId: string }): ReactNode {
  const t = useT();
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
      <Box>
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
