import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
} from '@helpdock/schemas';
import { Box, Button, Link as MuiLink, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { clockTime } from '../channels/format.js';
import { Card } from './card.tsx';
import { deliveriesKey, OutcomeLabel } from './delivery-log.tsx';
import {
  clockSeconds,
  deliveryOutcome,
  durationText,
  headerName,
  nextRetryAt,
  prettyBody,
  requestText,
} from './format.js';

/**
 * The delivery detail beside the DeliveryLog (DESIGN §6.3, M8-03): the
 * attempts as chips, the request as it was sent — headers with the signature
 * marked, then the body — and the first 1 KB of what came back, never
 * rendered. "Replay" sends the same body again as a new delivery.
 */

export const VERIFY_DOCS_URL =
  'https://github.com/Docker-Hunterpedia/Helpdock/blob/main/docs/guides/webhooks.md#verifying-the-signature';

/** A delivery still being retried is read again this often while it is open. */
const REFRESH_MS = 10_000;

export function DeliveryDetail({
  webhookId,
  deliveryId,
  onReplayed,
}: {
  readonly webhookId: string;
  readonly deliveryId: string | null;
  onReplayed(delivery: WebhookDelivery): void;
}): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const tokens = useSemanticTokens();
  const headingId = useId();

  const detail = useQuery({
    queryKey: ['developers', 'delivery', webhookId, deliveryId],
    queryFn: () => api.delivery(brand.id, webhookId, deliveryId ?? ''),
    enabled: deliveryId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? REFRESH_MS : false),
  });

  const replay = useMutation({
    mutationFn: (id: string) => api.replayDelivery(brand.id, webhookId, id),
    onSuccess: async (delivery) => {
      await queryClient.invalidateQueries({ queryKey: deliveriesKey(brand.id, webhookId) });
      toast({ tone: 'success', message: t('developers:webhooks.toast.replayed') });
      onReplayed(delivery);
    },
    onError: () => {
      toast({ tone: 'danger', message: t('developers:failed') });
    },
  });

  const delivery = detail.data;
  if (deliveryId === null || delivery === undefined) {
    return (
      <Card>
        <Typography variant="body2" sx={{ padding: 4, color: 'text.secondary' }}>
          {t('developers:webhooks.detail.pick')}
        </Typography>
      </Card>
    );
  }

  const outcome = deliveryOutcome(delivery);
  const pre = {
    margin: 0,
    padding: 3,
    borderRadius: '6px',
    backgroundColor: tokens['bg.muted'],
    fontFamily: 'var(--hd-font-mono, monospace)',
    fontSize: 12,
    lineHeight: '20px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  } as const;
  const subheading = { fontSize: 13, fontWeight: 600 } as const;

  return (
    <Card labelledBy={headingId}>
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Typography
              id={headingId}
              component="h3"
              dir="ltr"
              sx={{
                fontFamily: 'var(--hd-font-mono, monospace)',
                fontSize: 14,
                fontWeight: 600,
                alignSelf: 'flex-start',
              }}
            >
              {delivery.event}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('developers:webhooks.detail.firstSent', {
                id: delivery.id,
                time: clockSeconds(delivery.createdAt, locale),
              })}
            </Typography>
          </Box>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            aria-label={t('developers:webhooks.detail.replayLabel')}
            startIcon={<RotateCcw size={14} aria-hidden="true" />}
            disabled={replay.isPending}
            onClick={() => {
              replay.mutate(delivery.id);
            }}
            sx={{ marginInlineStart: 'auto', flexShrink: 0 }}
          >
            {t('developers:webhooks.detail.replay')}
          </Button>
        </Box>

        <AttemptChips delivery={delivery} />

        <Typography component="h4" sx={subheading}>
          {t('developers:webhooks.detail.headers')}
        </Typography>
        {delivery.request.headers.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('developers:webhooks.detail.noHeaders')}
          </Typography>
        ) : (
          <>
            <RequestHeaders detail={delivery} preSx={pre} />
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('developers:webhooks.detail.signatureNote')}{' '}
              <MuiLink href={VERIFY_DOCS_URL} target="_blank" rel="noopener">
                {t('developers:webhooks.detail.verifyLink')}
              </MuiLink>
            </Typography>
          </>
        )}

        <Typography component="h4" sx={subheading}>
          {t('developers:webhooks.detail.body')}
        </Typography>
        <Box
          component="pre"
          dir="ltr"
          tabIndex={0}
          sx={{ ...pre, maxHeight: 320, overflowY: 'auto' }}
        >
          {prettyBody(delivery.request.body)}
        </Box>

        {delivery.attempts === 0 ? null : (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography component="h4" sx={subheading}>
                {t('developers:webhooks.detail.response')}
              </Typography>
              <OutcomeLabel delivery={delivery} />
              {delivery.durationMs === null ? null : (
                <Typography
                  component="span"
                  sx={{
                    fontFamily: 'var(--hd-font-mono, monospace)',
                    fontSize: 12,
                    color: 'text.secondary',
                  }}
                >
                  <bdi dir="ltr">{durationText(delivery.durationMs, locale)}</bdi>
                </Typography>
              )}
            </Box>
            <Box component="pre" dir="ltr" tabIndex={0} sx={pre}>
              {delivery.responseExcerpt ??
                t('developers:webhooks.detail.noResponse', { error: delivery.error ?? '' })}
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t(
                outcome === 'refused'
                  ? 'developers:webhooks.detail.refusedNote'
                  : 'developers:webhooks.detail.responseNote',
              )}
            </Typography>
          </>
        )}
      </Box>
    </Card>
  );
}

function RequestHeaders({
  detail,
  preSx,
}: {
  readonly detail: WebhookDeliveryDetail;
  readonly preSx: object;
}): ReactNode {
  const tokens = useSemanticTokens();
  const lines = requestText(detail.request.url, detail.request.headers).split('\n');
  const signaturePrefix = `${headerName(WEBHOOK_SIGNATURE_HEADER)}:`;

  return (
    <Box component="pre" dir="ltr" tabIndex={0} sx={preSx}>
      {lines.map((line) => (
        <Box component="span" key={line} sx={{ display: 'block' }}>
          {line.startsWith(signaturePrefix) ? (
            <Box
              component="mark"
              sx={{ backgroundColor: tokens['status.warning.tint'], color: 'inherit' }}
            >
              {line}
            </Box>
          ) : (
            line
          )}
        </Box>
      ))}
    </Box>
  );
}

type Chip = {
  readonly key: string;
  readonly text: string;
  readonly tone: 'danger' | 'success' | 'next';
};

/** The attempts so far as chips, the next one dashed, then how many are left. */
function AttemptChips({ delivery }: { readonly delivery: WebhookDelivery }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const outcome = deliveryOutcome(delivery);
  const next = nextRetryAt(delivery);

  if (delivery.attempts === 0) {
    return null;
  }

  const lastLabel =
    outcome === 'delivered' || outcome === 'http'
      ? String(delivery.responseStatus)
      : t(`developers:webhooks.outcome.${outcome}`);
  const chips: Chip[] = [
    ...Array.from({ length: delivery.attempts - 1 }, (_, index) => ({
      key: `a${index + 1}`,
      text: t('developers:webhooks.detail.chipFailed', { attempt: index + 1 }),
      tone: 'danger' as const,
    })),
    {
      key: 'last',
      text: t('developers:webhooks.detail.chipLast', {
        attempt: delivery.attempts,
        time: clockTime(delivery.lastAttemptAt ?? delivery.createdAt, locale),
        outcome: lastLabel,
      }),
      tone: outcome === 'delivered' ? 'success' : 'danger',
    },
    ...(next === null
      ? []
      : [
          {
            key: 'next',
            text: t('developers:webhooks.detail.chipNext', {
              attempt: delivery.attempts + 1,
              time: clockTime(next, locale),
            }),
            tone: 'next' as const,
          },
        ]),
  ];
  const from = delivery.attempts + 2;
  const left =
    next === null || from > WEBHOOK_DELIVERY_ATTEMPTS
      ? null
      : from === WEBHOOK_DELIVERY_ATTEMPTS
        ? t('developers:webhooks.detail.leftOne', { from })
        : t('developers:webhooks.detail.left', { from, to: WEBHOOK_DELIVERY_ATTEMPTS });

  const chipSx = (tone: Chip['tone']) =>
    tone === 'next'
      ? { border: `1px dashed ${tokens['border.strong']}`, color: tokens['text.secondary'] }
      : {
          backgroundColor: tokens[`status.${tone}.tint`],
          color: tokens[`status.${tone}.text`],
        };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Box
        component="ol"
        aria-label={t('developers:webhooks.detail.attempts')}
        sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', gap: 1, flexWrap: 'wrap' }}
      >
        {chips.map((chip) => (
          <Box
            component="li"
            key={chip.key}
            sx={{
              paddingBlock: 1,
              paddingInline: 2,
              borderRadius: '6px',
              fontSize: 12,
              lineHeight: '16px',
              ...chipSx(chip.tone),
            }}
          >
            {chip.text}
          </Box>
        ))}
      </Box>
      {left === null ? null : (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {left}
        </Typography>
      )}
    </Box>
  );
}
