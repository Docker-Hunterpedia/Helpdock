import { monoFontStyle } from '@helpdock/ui';
import { Box, Button, Chip, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { SETTINGS_PASSKEYS_QUERY_KEY } from '../../../settings/api.js';
import { useSettingsApi } from '../../../settings/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { formatDay } from '../../../ui/format.js';
import { useToast } from '../../../ui/toasts.tsx';
import { EnvironmentLock } from './environment-lock.tsx';
import { fillSlots, PasskeysDriftBanner, SLOTS } from './passkeys-drift-banner.tsx';

/**
 * The Passkeys card of `Admin/Settings-Authentication` (M18-06): whether passkeys
 * work, the RP ID they were made for (read-only, pinned by the first
 * registration), and how many exist. Nothing to configure in the normal case.
 *
 * When the install's address moved the card is Paused and says both hosts; the
 * install admin can then move the passkeys, which removes them all (they cannot
 * work on the new host) and emails their holders.
 */

export function PasskeysSection(): ReactNode {
  const t = useT();
  const api = useSettingsApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const id = useId();
  const [moving, setMoving] = useState(false);
  const query = useQuery({ queryKey: SETTINGS_PASSKEYS_QUERY_KEY, queryFn: () => api.passkeys() });
  const move = useMutation({
    mutationFn: () => api.movePasskeys(),
    onSuccess: async ({ passkeysRemoved }) => {
      setMoving(false);
      await queryClient.invalidateQueries({ queryKey: SETTINGS_PASSKEYS_QUERY_KEY });
      toast({ tone: 'success', message: t('settings:passkeys.moved', { count: passkeysRemoved }) });
    },
    onError: async () => {
      setMoving(false);
      // A refusal may mean the counts moved since the page loaded.
      await queryClient.invalidateQueries({ queryKey: SETTINGS_PASSKEYS_QUERY_KEY });
      toast({ tone: 'danger', message: t('settings:passkeys.moveError') });
    },
  });

  if (query.isPending) {
    return null;
  }
  if (query.error || query.data === undefined) {
    return <AlertBanner tone="danger">{t('settings:passkeys.loadError')}</AlertBanner>;
  }

  const status = query.data;
  const blocked =
    status.blockers.breakGlassAccounts > 0 || status.blockers.secondFactorAccounts > 0;
  const title = t('settings:passkeys.title');

  return (
    <Box
      component="section"
      aria-labelledby={`${id}-title`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <KeyRound size={16} aria-hidden="true" />
        <Typography id={`${id}-title`} variant="bodyStrong" component="h3">
          {title}
        </Typography>
        <Chip
          size="small"
          color={
            status.state === 'available'
              ? 'success'
              : status.state === 'paused'
                ? 'warning'
                : 'default'
          }
          label={t(`settings:passkeys.status.${status.state}`)}
        />
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {status.state === 'unavailable'
          ? t('settings:passkeys.captionUnavailable')
          : t('settings:passkeys.caption')}
      </Typography>

      {status.state === 'unavailable' ? (
        <AlertBanner tone="info">
          {fillSlots(t('settings:passkeys.unavailableBody', { appUrl: SLOTS[2] }), {
            [SLOTS[2]]: <code style={{ ...monoFontStyle }}>APP_URL</code>,
          })}
        </AlertBanner>
      ) : null}

      {status.state === 'paused' && status.rpId !== null && status.pinnedRpId !== null ? (
        <>
          <PasskeysDriftBanner from={status.pinnedRpId} to={status.rpId} />
          {status.pinLocked ? (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('settings:passkeys.moveLocked')}
            </Typography>
          ) : (
            <Box>
              <Button
                type="button"
                variant="outlined"
                onClick={() => {
                  setMoving(true);
                }}
              >
                {t('settings:passkeys.move', { host: status.rpId })}
              </Button>
            </Box>
          )}
          <ConfirmDialog
            open={moving}
            destructive
            busy={move.isPending}
            title={t('settings:passkeys.moveTitle', { host: status.rpId })}
            body={t('settings:passkeys.moveBody')}
            confirmLabel={t('settings:passkeys.moveConfirm')}
            confirmDisabled={blocked}
            onClose={() => {
              setMoving(false);
            }}
            onConfirm={() => {
              move.mutate();
            }}
          >
            {blocked ? (
              <AlertBanner tone="danger">
                <Box component="strong" sx={{ display: 'block', fontWeight: 600 }}>
                  {t('settings:passkeys.moveBlockedTitle')}
                </Box>
                {status.blockers.breakGlassAccounts > 0 ? (
                  <Box component="span" sx={{ display: 'block' }}>
                    {t('settings:passkeys.moveBlockedBreakGlass', {
                      count: status.blockers.breakGlassAccounts,
                    })}
                  </Box>
                ) : null}
                {status.blockers.secondFactorAccounts > 0 ? (
                  <Box component="span" sx={{ display: 'block' }}>
                    {t('settings:passkeys.moveBlockedSecondFactor', {
                      count: status.blockers.secondFactorAccounts,
                    })}
                  </Box>
                ) : null}
                {t('settings:passkeys.moveBlockedHint')}
              </AlertBanner>
            ) : null}
          </ConfirmDialog>
        </>
      ) : null}

      {status.state === 'available' ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gap: 4,
          }}
        >
          <RpIdField
            id={`${id}-rp-id`}
            status={status}
            date={formatDate(status.pinnedAt, locale)}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <Typography sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px' }}>
              {t('settings:passkeys.inUse')}
            </Typography>
            <Typography variant="body2" sx={{ lineHeight: '36px' }}>
              {status.passkeyCount === 0
                ? t('settings:passkeys.inUseNone')
                : t('settings:passkeys.inUseValue', {
                    count: status.passkeyCount,
                    staff: status.holderCount,
                  })}
            </Typography>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

const formatDate = (iso: string | null, locale: Parameters<typeof formatDay>[1]): string | null =>
  iso === null ? null : formatDay(iso, locale);

function RpIdField({
  id,
  status,
  date,
}: {
  readonly id: string;
  readonly status: {
    readonly rpId: string | null;
    readonly pinnedRpId: string | null;
    readonly pinLocked: boolean;
  };
  readonly date: string | null;
}): ReactNode {
  const t = useT();
  const hint =
    status.pinnedRpId === null
      ? t('settings:passkeys.rpIdNone')
      : status.pinLocked
        ? t('settings:passkeys.rpIdEnvironment')
        : date === null
          ? t('settings:passkeys.rpIdEnvironment')
          : t('settings:passkeys.rpIdPinned', { date });

  return (
    <Field
      id={id}
      label={t('settings:passkeys.rpId')}
      hint={hint}
      action={status.pinLocked ? <EnvironmentLock /> : undefined}
    >
      <TextField
        id={id}
        value={status.pinnedRpId ?? status.rpId ?? ''}
        slotProps={{
          htmlInput: {
            readOnly: true,
            dir: 'ltr',
            style: { ...monoFontStyle },
            'aria-describedby': fieldDescribedBy(id, { hint }),
          },
        }}
      />
    </Field>
  );
}
