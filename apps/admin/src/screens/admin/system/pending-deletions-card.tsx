import type { Brand, BrandDeletion } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { formatDay } from '../../../ui/format.js';
import { useToast } from '../../../ui/toasts.tsx';
import { Card } from './card.js';
import { daysLeft, isLastDays } from './deletion-countdown.js';
import { brandDeletionQueryKey, INSTALL_BRANDS_QUERY_KEY, type SystemApi } from './system-api.js';

/**
 * "Brands pending deletion" on `Admin/System-1.0` (M8-07): every brand in its
 * 30-day grace as a PendingDeletionRow (DESIGN §6.3), with Restore. The
 * artboard's "Deleted by" is drawn as the date alone: the deletion read does
 * not name who asked.
 */
export function PendingDeletionsCard({
  api,
  pending,
}: {
  readonly api: SystemApi;
  /** The install's brands whose status is `deleting`. */
  readonly pending: readonly Brand[];
}): ReactNode {
  const t = useT();
  const deletions = useQueries({
    queries: pending.map((brand) => ({
      queryKey: brandDeletionQueryKey(brand.id),
      queryFn: () => api.brandDeletion(brand.id),
    })),
  });

  return (
    <Card
      title={t('system:pending.title')}
      action={
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:pending.caption', { count: pending.length })}
        </Typography>
      }
    >
      {pending.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:pending.empty')}
        </Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {pending.map((brand, index) => {
            const deletion = deletions[index]?.data;
            return deletion === undefined ? null : (
              <PendingDeletionRow key={brand.id} brand={brand} deletion={deletion} api={api} />
            );
          })}
        </Box>
      )}
      <Typography
        variant="caption"
        component="p"
        sx={{ color: 'text.secondary', fontWeight: 400, marginBlockStart: 3 }}
      >
        {t('system:pending.footer')}
      </Typography>
    </Card>
  );
}

function PendingDeletionRow({
  brand,
  deletion,
  api,
}: {
  readonly brand: Brand;
  readonly deletion: BrandDeletion;
  readonly api: SystemApi;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const toast = useToast();
  const queryClient = useQueryClient();

  const restore = useMutation({
    mutationFn: () => api.restoreBrand(brand.id),
    onSuccess: async () => {
      toast({ tone: 'success', message: t('system:pending.restored', { name: brand.name }) });
      await queryClient.invalidateQueries({ queryKey: INSTALL_BRANDS_QUERY_KEY });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('system:pending.restoreFailed', { name: brand.name }) });
    },
  });

  if (deletion.requestedAt === null || deletion.purgeAfter === null) {
    return null;
  }
  const days = daysLeft(deletion.purgeAfter);
  const urgent = isLastDays(days);

  return (
    <Box
      component="li"
      sx={{
        minHeight: 64,
        paddingBlock: 2,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto auto',
        alignItems: 'center',
        gap: 4,
        '& + &': { borderBlockStart: `1px solid ${tokens['bg.muted']}` },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography component="p" sx={{ fontSize: 13, fontWeight: 500 }}>
          {brand.name}{' '}
          <Typography
            variant="mono"
            component="span"
            sx={{ fontSize: 12, color: 'text.secondary' }}
          >
            {brand.prefix}
          </Typography>
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:pending.requested', { date: formatDay(deletion.requestedAt, locale) })}
        </Typography>
      </Box>
      <Box>
        <Typography
          variant="mono"
          component="p"
          sx={{
            fontWeight: 500,
            color: urgent ? tokens['status.warning.text'] : 'text.secondary',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          {urgent ? <TriangleAlert size={14} aria-hidden="true" /> : null}
          {t('system:pending.daysLeft', { count: days })}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:pending.purgeOn', { date: formatDay(deletion.purgeAfter, locale) })}
        </Typography>
      </Box>
      <Button
        variant="outlined"
        size="small"
        startIcon={<Undo2 size={16} aria-hidden="true" />}
        disabled={restore.isPending}
        aria-label={t('system:pending.restoreBrand', { name: brand.name })}
        onClick={() => {
          restore.mutate();
        }}
      >
        {t('system:pending.restore')}
      </Button>
    </Box>
  );
}
