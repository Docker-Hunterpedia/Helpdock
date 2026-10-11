import {
  type Attachment,
  META_ATTACHMENT_LIMITS,
  type MetaDeliveryView,
  type MetaLeftOut,
  type MetaPlatform,
} from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { Ban, Check, CheckCheck, Clock, RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans } from 'react-i18next';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { clockTime } from './meta-format.js';

/**
 * What became of an agent's reply on WhatsApp, Messenger or Instagram (M10-06,
 * M10-08, `Admin/Ticket-Meta` panels 2, 3 and 6).
 *
 * Two pieces. {@link DeliveryTrail} ends the reply's caption — "Lina Haddad ·
 * to WhatsApp · 09:20 · Read 09:21" — with the state the platform last reported:
 * Sending (with the part), Sent, Delivered, Read. A state only moves forward,
 * which the api guarantees; one check until Read and two for Read, as the
 * widget's Seen, with the word always saying which. {@link DeliveryNotice} sits
 * under the bubble for the two ends that need words: a reply the platform
 * **refused** because the window had closed (no Retry: the customer has to write
 * first) and one that **failed** (Retry resumes after the last part the platform
 * accepted), and for a file the platform would not take.
 *
 * Nothing here is a live region. The thread is a log (`aria-live="polite"`):
 * a failure strip that arrives is read, and Sent, Delivered and Read changing
 * in place are not.
 */

const mono = { fontSize: 12 } as const;

export function DeliveryTrail({ delivery }: { readonly delivery: MetaDeliveryView }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  if (delivery.status === 'failed' || delivery.status === 'refused') {
    return null;
  }

  const state = ((): ReactNode => {
    switch (delivery.status) {
      case 'queued':
        return (
          <Step icon={<Clock size={14} />}>
            {delivery.partsTotal > 1
              ? t('tickets:meta.sendingPart', {
                  part: Math.min(delivery.partsSent + 1, delivery.partsTotal),
                  total: delivery.partsTotal,
                })
              : t('tickets:meta.sending')}
          </Step>
        );
      case 'sent':
        return <Step icon={<Check size={14} />}>{t('tickets:meta.sent')}</Step>;
      case 'delivered':
        return (
          <Step
            icon={<Check size={14} />}
            time={delivery.deliveredAt === null ? null : clockTime(delivery.deliveredAt, locale)}
          >
            {t('tickets:meta.delivered')}
          </Step>
        );
      case 'read':
        return (
          <Step
            icon={<CheckCheck size={14} />}
            time={delivery.readAt === null ? null : clockTime(delivery.readAt, locale)}
          >
            {t('tickets:meta.read')}
          </Step>
        );
    }
  })();

  return (
    <>
      <span aria-hidden="true"> · </span>
      {state}
      {delivery.partsTotal > 1 ? (
        <>
          <span aria-hidden="true"> · </span>
          {t('tickets:meta.messages', { count: delivery.partsTotal })}
        </>
      ) : null}
    </>
  );
}

/** A state: the 14 px icon and the word, then the time the platform reported it. */
function Step({
  icon,
  time,
  children,
}: {
  readonly icon: ReactNode;
  readonly time?: string | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, verticalAlign: 'middle' }}
    >
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex' }}>
        {icon}
      </Box>
      {children}
      {time === undefined || time === null ? null : (
        <Typography variant="mono" component="span" sx={mono}>
          <bdi>{time}</bdi>
        </Typography>
      )}
    </Box>
  );
}

/** "WhatsApp: “Something went wrong” (131000)": the platform's words and its code. */
const saidBy = (
  delivery: MetaDeliveryView,
  platformName: string,
  t: ReturnType<typeof useT>,
): string | null => {
  if (delivery.lastError === null) {
    return null;
  }
  const said = t('tickets:meta.platformSaid', { platform: platformName, error: delivery.lastError });

  return delivery.errorCode === null
    ? said
    : `${said} ${t('tickets:meta.code', { code: delivery.errorCode })}`;
};

/** The sentence under a file the platform did not take, for the reason the api recorded. */
const leftOutReason = (
  item: MetaLeftOut,
  platform: MetaPlatform,
  attachments: readonly Attachment[],
): 'pdfOnly' | 'unsupported-type' | 'too-large' => {
  if (item.reason === 'too-large') {
    return 'too-large';
  }
  const isFile = attachments.find((attachment) => attachment.id === item.attachmentId)?.kind === 'file';

  return isFile && META_ATTACHMENT_LIMITS[platform].fileTypes !== null
    ? 'pdfOnly'
    : 'unsupported-type';
};

export function DeliveryNotice({
  delivery,
  platform,
  attachments,
  busy,
  onRetry,
}: {
  readonly delivery: MetaDeliveryView;
  readonly platform: MetaPlatform;
  /** The reply's own files, to tell a document from an image in "left out". */
  readonly attachments: readonly Attachment[];
  readonly busy: boolean;
  onRetry(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const platformName = t(`tickets:channel.${platform}`);
  const refused = delivery.status === 'refused';
  const failed = delivery.status === 'failed';
  const said = saidBy(delivery, platformName, t);

  const details = refused
    ? [t('tickets:meta.refusedWindow'), said]
    : [
        delivery.partsTotal > 1
          ? t('tickets:meta.partOf', {
              part: Math.min(delivery.partsSent + 1, delivery.partsTotal),
              total: delivery.partsTotal,
            })
          : null,
        said,
        delivery.attempts > 0 ? t('tickets:meta.attempts', { count: delivery.attempts }) : null,
      ];

  return (
    <>
      {refused || failed ? (
        <Box sx={{ marginBlockStart: 2 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              paddingBlock: 1,
              paddingInline: 3,
              borderRadius: '6px',
              border: `1px solid ${tokens['status.danger']}`,
              backgroundColor: tokens['status.danger.tint'],
              color: tokens['status.danger.text'],
            }}
          >
            <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', flexShrink: 0 }}>
              {refused ? <Ban size={14} /> : <TriangleAlert size={14} />}
            </Box>
            <Typography
              variant="caption"
              sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'inherit' }}
            >
              <strong>{t(refused ? 'tickets:meta.refused' : 'tickets:meta.notDelivered')}</strong>
              {details
                .filter((part): part is string => part !== null)
                .map((part) => (
                  <span key={part}>
                    {' · '}
                    <bdi>{part}</bdi>
                  </span>
                ))}
            </Typography>
            {failed ? (
              <Button
                size="small"
                variant="text"
                disabled={busy}
                startIcon={<RotateCw size={14} aria-hidden="true" />}
                onClick={onRetry}
                aria-label={t('tickets:meta.retryLabel', { channel: platformName })}
                sx={{ color: 'inherit' }}
              >
                {t('tickets:meta.retry')}
              </Button>
            ) : null}
          </Box>
          <Typography
            variant="caption"
            component="p"
            sx={{ color: 'text.secondary', marginBlockStart: 1 }}
          >
            {refused
              ? t('tickets:meta.refusedNoRetry')
              : delivery.partsSent > 0
                ? t('tickets:meta.earlierParts', { count: delivery.partsSent })
                : null}
          </Typography>
        </Box>
      ) : null}

      {delivery.leftOut.map((item) => (
        <Typography
          key={item.attachmentId}
          variant="caption"
          component="p"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            marginBlockStart: 2,
            color: tokens['status.warning.text'],
          }}
        >
          <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', flexShrink: 0 }}>
            <TriangleAlert size={14} />
          </Box>
          <span>
            <Trans
              i18nKey="tickets:meta.leftOut"
              values={{
                name: item.name,
                reason: t(`tickets:meta.leftOutReason.${leftOutReason(item, platform, attachments)}`, {
                  platform: platformName,
                }),
              }}
              components={{ bdi: <bdi /> }}
            />
          </span>
        </Typography>
      ))}
    </>
  );
}
