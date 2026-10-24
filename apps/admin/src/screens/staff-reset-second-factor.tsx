import type { PasskeyProof, StaffMember } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../app/i18n.js';
import { isAuthError } from '../auth/api.js';
import { useAuthApi, useStaffApi } from '../auth/session.tsx';
import { isStaffError } from '../staff/api.js';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { useToast } from '../ui/toasts.tsx';
import { PASSKEYS_KEY } from './account/passkeys-card.tsx';
import { StepUpDialog } from './account/step-up-dialog.tsx';

/**
 * Resetting another person's second factor (#398, artboard
 * `Admin/Staff-ResetSecondFactor`): the shared step-up dialog first, then a
 * destructive confirm that lists what goes with the server's own counts.
 *
 * The proof is only collected at step 1; the api checks it with the reset, so
 * a wrong password is said back at step 1 and nothing has been removed. The
 * confirm carries the digest of the factors it listed, so a person whose
 * factors changed meanwhile is answered "changed" rather than reset blind.
 */
export function ResetSecondFactorFlow({
  member,
  onClose,
  onDone,
}: {
  readonly member: StaffMember;
  onClose(): void;
  onDone(): Promise<void>;
}): ReactNode {
  const t = useT();
  const staffApi = useStaffApi();
  const authApi = useAuthApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [proof, setProof] = useState<PasskeyProof | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

  const passkeys = useQuery({ queryKey: PASSKEYS_KEY, queryFn: () => authApi.passkeys() });
  const summary = useQuery({
    queryKey: ['staff', 'second-factor', member.userId],
    queryFn: () => staffApi.secondFactorSummary(member.userId),
    enabled: proof !== null,
    gcTime: 0,
    retry: false,
  });

  const refuse = (error: unknown): void => {
    onClose();
    const name = member.name;
    const key = isStaffError(error)
      ? error.reason === 'last-break-glass'
        ? 'staff:toast.lastBreakGlass'
        : error.reason === 'reset-rate-limited'
          ? 'staff:toast.resetRateLimited'
          : error.reason === 'second-factor-changed' || error.reason === 'not-resettable'
            ? 'staff:toast.secondFactorChanged'
            : 'staff:toast.failed'
      : 'staff:toast.failed';
    toast({ tone: 'danger', message: t(key, { name }) });
  };

  const reset = useMutation({
    mutationFn: (input: { proof: PasskeyProof; digest: string; required: boolean }) =>
      staffApi.resetSecondFactor(member.userId, input.proof, input.digest),
    onSuccess: async (_removed, input) => {
      onClose();
      await onDone();
      toast({
        tone: 'success',
        message: t(
          input.required
            ? 'staff:toast.secondFactorReset'
            : 'staff:toast.secondFactorResetOptional',
          { name: member.name },
        ),
      });
    },
    onError: (error: unknown) => {
      if (isAuthError(error)) {
        // The admin's own proof was refused; nothing was removed, so they try again at step 1.
        setProof(null);
        void queryClient.removeQueries({ queryKey: ['staff', 'second-factor', member.userId] });
        setProofError(
          error.code === 'totp-locked'
            ? t('me:passkeys.locked')
            : error.code === 'challenge-expired'
              ? t('me:passkeys.passkeyProofFailed')
              : t('me:passkeys.proofWrong'),
        );
        return;
      }
      refuse(error);
    },
  });

  const summaryFailed = summary.isError;
  const summaryError = summary.error;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refuse` closes over props that only change with the member; the failure is reported once.
  useEffect(() => {
    if (summaryFailed) refuse(summaryError);
  }, [summaryFailed, summaryError]);
  if (summaryFailed) return null;

  if (proof === null) {
    return (
      <StepUpDialog
        body={t('staff:reset.stepUp', { name: member.name })}
        hasPasskeys={(passkeys.data?.passkeys.length ?? 0) > 0}
        busy={false}
        error={proofError}
        onClose={onClose}
        onProof={(given) => {
          setProofError(null);
          setProof(given);
        }}
      />
    );
  }

  const found = summary.data;

  return (
    <ConfirmDialog
      open
      destructive
      busy={reset.isPending}
      confirmDisabled={found === undefined}
      title={t('staff:reset.title', { name: member.name })}
      body={t(
        found?.enrolmentRequired === false
          ? 'staff:reset.consequenceOptional'
          : 'staff:reset.consequence',
        { name: member.name },
      )}
      confirmLabel={t('staff:reset.submit')}
      onClose={onClose}
      onConfirm={() => {
        if (found !== undefined)
          reset.mutate({
            proof,
            digest: found.digest,
            required: found.enrolmentRequired,
          });
      }}
    >
      {found === undefined ? null : (
        <Box component="section" aria-label={t('staff:reset.removes')}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('staff:reset.removes')}
          </Typography>
          <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {[
              found.totp ? t('staff:reset.app') : null,
              found.passkeys > 0 ? t('staff:reset.passkeys', { count: found.passkeys }) : null,
              found.recoveryCodes > 0
                ? t('staff:reset.codes', { count: found.recoveryCodes })
                : null,
            ]
              .filter((line): line is string => line !== null)
              .map((line) => (
                <Box
                  component="li"
                  key={line}
                  sx={{ display: 'flex', alignItems: 'center', gap: 2, paddingBlock: 1 }}
                >
                  <X size={14} aria-hidden="true" />
                  <Typography variant="body2">{line}</Typography>
                </Box>
              ))}
          </Box>
        </Box>
      )}
      <AlertBanner tone="warning">{t('staff:reset.warning', { name: member.name })}</AlertBanner>
    </ConfirmDialog>
  );
}
