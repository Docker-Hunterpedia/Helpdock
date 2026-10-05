import type { WebhookDelivery } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { deliveryOutcome, durationText } from './format.js';

/**
 * Not yet attempted. A ping whose first attempt failed is `pending` too, until
 * its retries run out, but the Admin already has the answer that matters.
 */
const awaiting = (ping: WebhookDelivery): boolean =>
  ping.status === 'pending' && ping.attempts === 0;

/** How often a queued ping is read back while the dialog waits for it. */
const POLL_MS = 1_000;

/**
 * "Test event" in the "Endpoint added" dialog (`Admin/Developers-Webhooks`
 * panel 2): sends a `ping` through the real delivery path and waits for its
 * outcome, so the Admin learns now — not with the first real event — whether
 * the endpoint answers.
 */
export function TestEventBox({ webhookId }: { readonly webhookId: string }): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const { locale } = usePreferences();

  const send = useMutation({ mutationFn: () => api.sendTestEvent(brand.id, webhookId) });
  const pingId = send.data?.id;
  const watched = useQuery({
    queryKey: ['developers', 'delivery', webhookId, pingId],
    queryFn: () => api.delivery(brand.id, webhookId, pingId ?? ''),
    enabled: pingId !== undefined,
    refetchInterval: (query) =>
      query.state.data === undefined || awaiting(query.state.data) ? POLL_MS : false,
  });
  const ping: WebhookDelivery | undefined = watched.data ?? send.data;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography component="h3" sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('developers:webhooks.test.heading')}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={<Send size={14} aria-hidden="true" />}
          disabled={send.isPending || (ping !== undefined && awaiting(ping))}
          onClick={() => {
            send.mutate();
          }}
        >
          {t('developers:webhooks.test.send')}
        </Button>
      </Box>
      <Box role="status" sx={{ minBlockSize: 18 }}>
        {send.isError ? (
          <Result tone="danger" text={t('developers:failed')} />
        ) : ping === undefined ? null : awaiting(ping) ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('developers:webhooks.test.sending')}
          </Typography>
        ) : ping.status === 'succeeded' ? (
          <Result
            tone="success"
            text={t('developers:webhooks.test.delivered', {
              status: ping.responseStatus ?? '',
              duration: durationText(ping.durationMs ?? 0, locale),
            })}
          />
        ) : (
          <Result
            tone="danger"
            text={t('developers:webhooks.test.failed', {
              outcome:
                deliveryOutcome(ping) === 'http'
                  ? String(ping.responseStatus)
                  : t(`developers:webhooks.outcome.${deliveryOutcome(ping)}`),
            })}
          />
        )}
      </Box>
    </Box>
  );
}

function Result({
  tone,
  text,
}: {
  readonly tone: 'success' | 'danger';
  readonly text: string;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Typography
      variant="caption"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        color: tokens[`status.${tone}.text`],
      }}
    >
      {tone === 'success' ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <CircleAlert size={14} aria-hidden="true" />
      )}
      {text}
    </Typography>
  );
}
