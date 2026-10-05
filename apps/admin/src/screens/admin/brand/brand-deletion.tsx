import type { BrandDeletion, SessionBrand } from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { formatDay } from '../../../ui/format.js';
import { useToast } from '../../../ui/toasts.tsx';
import {
  brandDeletionQueryKey,
  INSTALL_BRANDS_QUERY_KEY,
  SystemApiError,
} from '../system/system-api.js';
import { useSystemApi } from '../system/system-api-context.tsx';

/**
 * Brand deletion on `Admin/Brand-Danger` (M8-07, DOMAIN-RULES §11): the
 * "Delete this brand" card, and the banner with Restore that every tab shows
 * while the brand is in its 30-day grace. Both routes are an install admin's,
 * so a brand admin who is not one reads the card's caption and nothing else.
 *
 * The artboard asks for the brand's name to be typed; the api checks its
 * ticket prefix (`brandDeletionRequestSchema`), so the prefix is what is asked
 * for here.
 */

/** Where the brand is in its deletion; only asked for by an install admin. */
export function useBrandDeletion(
  brandId: string,
  installAdmin: boolean,
): UseQueryResult<BrandDeletion> {
  const api = useSystemApi();

  return useQuery({
    queryKey: brandDeletionQueryKey(brandId),
    queryFn: () => api.brandDeletion(brandId),
    enabled: installAdmin,
    retry: false,
  });
}

const useRefreshDeletion = (brandId: string) => {
  const queryClient = useQueryClient();

  return async (deletion: BrandDeletion): Promise<void> => {
    queryClient.setQueryData(brandDeletionQueryKey(brandId), deletion);
    await queryClient.invalidateQueries({ queryKey: INSTALL_BRANDS_QUERY_KEY, exact: true });
  };
};

export function PendingDeletionBanner({
  brand,
  deletion,
}: {
  readonly brand: SessionBrand;
  readonly deletion: BrandDeletion;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const api = useSystemApi();
  const toast = useToast();
  const refresh = useRefreshDeletion(brand.id);

  const restore = useMutation({
    mutationFn: () => api.restoreBrand(brand.id),
    onSuccess: async (restored) => {
      await refresh(restored);
      toast({ tone: 'success', message: t('brand:deletion.restored', { name: brand.name }) });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('brand:deletion.restoreFailed') });
    },
  });

  if (deletion.status !== 'deleting' || deletion.purgeAfter === null) {
    return null;
  }

  return (
    <Box sx={{ marginBlockEnd: 6 }}>
      <AlertBanner tone="warning">
        <Box
          component="span"
          sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 3 }}
        >
          <span>
            {t('brand:deletion.scheduled', { date: formatDay(deletion.purgeAfter, locale) })}
          </span>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Undo2 size={16} aria-hidden="true" />}
            disabled={restore.isPending}
            onClick={() => {
              restore.mutate();
            }}
          >
            {t('brand:deletion.restore')}
          </Button>
        </Box>
      </AlertBanner>
    </Box>
  );
}

/** Which sentence a refused request gets. */
const refusalKey = (
  error: unknown,
): 'brand:deletion.wrongPrefix' | 'brand:deletion.alreadyDeleting' | 'brand:deletion.failed' => {
  if (error instanceof SystemApiError && error.status === 400) {
    return 'brand:deletion.wrongPrefix';
  }
  if (error instanceof SystemApiError && error.status === 409) {
    return 'brand:deletion.alreadyDeleting';
  }
  return 'brand:deletion.failed';
};

export function DeleteBrandCard({
  brand,
  installAdmin,
}: {
  readonly brand: SessionBrand;
  readonly installAdmin: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const api = useSystemApi();
  const toast = useToast();
  const refresh = useRefreshDeletion(brand.id);
  const headingId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState('');

  const remove = useMutation({
    mutationFn: () => api.deleteBrand(brand.id, typed),
    onSuccess: async (deletion) => {
      setTyped('');
      await refresh(deletion);
      toast({ tone: 'success', message: t('brand:deletion.requested', { name: brand.name }) });
    },
  });

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['status.danger']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box
        sx={{
          paddingBlock: 4,
          paddingInline: 5,
          borderBlockEnd: `1px solid ${tokens['status.danger.tint']}`,
          display: 'grid',
          gap: 1,
        }}
      >
        <Typography
          id={headingId}
          variant="h3"
          component="h2"
          sx={{ color: tokens['status.danger.text'] }}
        >
          {t('brand:deletion.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('brand:deletion.body')}
        </Typography>
      </Box>

      <Box
        component="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (typed === brand.ticketPrefix) {
            remove.mutate();
          }
        }}
        sx={{ padding: 5, display: 'grid', gap: 3 }}
      >
        {remove.isError ? (
          <AlertBanner tone="danger">{t(refusalKey(remove.error))}</AlertBanner>
        ) : null}
        <Box sx={{ display: 'grid', gap: 1, maxWidth: 320 }}>
          <Typography component="label" htmlFor={inputId} sx={{ fontSize: 13, fontWeight: 500 }}>
            {t('brand:deletion.confirm', { prefix: brand.ticketPrefix })}
          </Typography>
          <TextField
            id={inputId}
            size="small"
            value={typed}
            disabled={!installAdmin || remove.isPending}
            placeholder={t('brand:deletion.placeholder')}
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <Button
            type="submit"
            variant="contained"
            color="error"
            disabled={!installAdmin || typed !== brand.ticketPrefix || remove.isPending}
          >
            {t('brand:deletion.submit')}
          </Button>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('brand:deletion.installAdminsOnly')}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
