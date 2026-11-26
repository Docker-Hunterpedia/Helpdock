import type { TicketPortalView } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession, useTicketsApi } from '../../auth/session.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import { Switch } from '../../ui/switch.tsx';
import { useToast } from '../../ui/toasts.tsx';

/**
 * The "Customer portal" card of the details panel (M21-06,
 * `Admin/Portal-Settings`, ticket details): one switch, "Private to the
 * requester", and the line that says who can see the ticket in the portal now.
 *
 * It is drawn only while the brand's portal is on, because with the portal off
 * nobody can see the ticket there whatever it says. Needs `ticket:write`; a
 * Viewer sees the state with the switch disabled. The change is written to the
 * ticket's activity and the audit log by the api.
 */
export function PortalCard({
  ticketId,
  portal,
  canWrite,
}: {
  readonly ticketId: string;
  readonly portal: TicketPortalView;
  readonly canWrite: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const api = useTicketsApi();
  const queryClient = useQueryClient();
  const brand = currentBrand(useSession());
  const id = useId();

  const change = useMutation({
    mutationFn: (value: boolean) => api.setPortalPrivate(brand.id, ticketId, value),
    onSuccess: async (_view, value) => {
      await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brand.id, ticketId) });
      toast({
        tone: 'success',
        message: t(value ? 'tickets:portal.markedOn' : 'tickets:portal.markedOff'),
      });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('tickets:portal.failed') });
    },
  });

  const requester = portal.requester;
  const visibleTo = [
    requester === null ? null : requester,
    portal.company === null
      ? null
      : t(
          portal.company.audience === 'all'
            ? 'tickets:portal.companyAll'
            : 'tickets:portal.companyManagers',
          { account: portal.company.name },
        ),
  ].filter((part): part is string => part !== null);

  return (
    <Box
      component="section"
      aria-labelledby={`${id}-heading`}
      sx={{
        display: 'grid',
        gap: 3,
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography id={`${id}-heading`} variant="bodyStrong" component="h2">
        {t('tickets:portal.title')}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
        <Switch
          checked={portal.private}
          label={t('tickets:portal.private')}
          describedBy={`${id}-hint`}
          busy={change.isPending}
          disabled={!canWrite || change.isPending}
          onChange={(value) => {
            change.mutate(value);
          }}
        />
        <Box sx={{ display: 'grid', gap: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {t('tickets:portal.private')}
          </Typography>
          <Typography id={`${id}-hint`} variant="caption" sx={{ color: 'text.secondary' }}>
            {portal.private
              ? requester === null
                ? t('tickets:portal.hintOnNoName')
                : t('tickets:portal.hintOn', { name: requester })
              : t('tickets:portal.hintOff')}
          </Typography>
        </Box>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {`${t('tickets:portal.nowVisible')} `}
        <bdi>{visibleTo.length === 0 ? t('tickets:portal.nobody') : visibleTo.join(' · ')}</bdi>
      </Typography>
    </Box>
  );
}
