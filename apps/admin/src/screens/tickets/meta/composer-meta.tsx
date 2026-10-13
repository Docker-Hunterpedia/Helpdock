import { type Attachment, META_TEXT_LIMITS } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { Trans } from 'react-i18next';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { PLATFORM_ICONS } from '../../admin/channels/meta/platforms.js';
import { planMetaMessages } from './meta-count.js';
import type { ComposerMeta } from './use-ticket-meta.tsx';

/**
 * The Composer's Meta mode (DESIGN §6.3, M10-06, M10-08, `Admin/Ticket-Meta`
 * panel 5): for a public reply on a WhatsApp, Messenger or Instagram ticket,
 * who the reply goes to and from which account, and under the textarea how many
 * messages it becomes. A note is unchanged.
 */

/** "To Daniel Reyes on WhatsApp +44 7700 900123 · from +1 555 0142", the ChannelIcon first. */
export function MetaRecipient({ meta }: { readonly meta: ComposerMeta }): ReactNode {
  const t = useT();
  const Icon = PLATFORM_ICONS[meta.platform];

  return (
    <Typography
      variant="caption"
      sx={{
        color: 'text.secondary',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        marginInlineStart: 'auto',
      }}
    >
      <Icon size={14} aria-hidden="true" />
      <span>
        <Trans
          ns="tickets"
          i18nKey={meta.handle === undefined ? 'meta.composer.to' : 'meta.composer.toHandle'}
          values={{
            name: meta.customerName,
            platform: t(`tickets:channel.${meta.platform}`),
            handle: meta.handle ?? '',
            account: meta.account,
          }}
          components={{ bdi: <bdi dir="auto" /> }}
        />
      </span>
    </Typography>
  );
}

/**
 * "Plain text. Sent as 3 messages: 1 text, 2 attachments. Meta may charge for
 * each." The count is in weight 600; on WhatsApp the sentence ends with the
 * charge, which only WhatsApp has. While the window is closed it says what the
 * reply would be and when Send turns on. A file that will be left out is named
 * before Send, in the warning text.
 */
export function MetaCount({
  meta,
  body,
  attachments,
}: {
  readonly meta: ComposerMeta;
  readonly body: string;
  readonly attachments: readonly Attachment[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { platform, openingLine } = meta;
  const plan = useMemo(
    () => planMetaMessages({ body, attachments, platform, openingLine }),
    [body, attachments, platform, openingLine],
  );
  const limit = META_TEXT_LIMITS[platform];
  const strong = <Box component="strong" sx={{ fontWeight: 600, color: tokens['text.primary'] }} />;

  const detail = [
    plan.textParts === 1 && plan.files > 0 ? t('tickets:meta.composer.detailText') : null,
    plan.textParts >= 2
      ? limit.unit === 'bytes'
        ? t('tickets:meta.composer.detailCutBytes', { count: plan.textParts, max: limit.max })
        : t('tickets:meta.composer.detailCutCharacters', { max: limit.max })
      : null,
    plan.files > 0 ? t('tickets:meta.composer.detailFiles', { count: plan.files }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(t('tickets:meta.composer.detailJoin'));

  const sentence = ((): ReactNode => {
    if (plan.total === 0) {
      return null;
    }
    if (meta.closed) {
      return (
        <Trans
          ns="tickets"
          i18nKey="meta.composer.wouldGo"
          count={plan.total}
          values={{ name: meta.customerName }}
          components={{ b: strong }}
        />
      );
    }

    return detail === '' ? (
      <Trans
        ns="tickets"
        i18nKey="meta.composer.count"
        count={plan.total}
        components={{ b: strong }}
      />
    ) : (
      <Trans
        ns="tickets"
        i18nKey="meta.composer.countWith"
        count={plan.total}
        values={{ detail }}
        components={{ b: strong }}
      />
    );
  })();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography
        variant="caption"
        component="p"
        sx={{ margin: 0, color: 'text.secondary', lineHeight: '16px' }}
      >
        {t('tickets:meta.composer.plain')}
        {sentence === null ? null : <> {sentence}</>}
        {platform === 'whatsapp' && plan.total > 0 && !meta.closed
          ? ` ${t(plan.total > 1 ? 'tickets:meta.composer.charge' : 'tickets:meta.composer.chargeOne')}`
          : null}
      </Typography>
      {plan.leftOut.map((file) => (
        <Typography
          key={file.name}
          variant="caption"
          component="p"
          sx={{
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            lineHeight: '16px',
            color: tokens['status.warning.text'],
          }}
        >
          <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', flexShrink: 0 }}>
            <TriangleAlert size={14} />
          </Box>
          <span>
            <Trans
              ns="tickets"
              i18nKey="meta.composer.leftOut"
              values={{
                name: file.name,
                reason: t('tickets:meta.leftOutReason.pdfOnly', {
                  platform: t(`tickets:channel.${platform}`),
                }),
              }}
              components={{ bdi: <bdi /> }}
            />
          </span>
        </Typography>
      ))}
    </Box>
  );
}
