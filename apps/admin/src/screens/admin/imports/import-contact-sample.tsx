import type { importContactPreviewSchema } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { z } from 'zod';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';

export function ImportContactSample({
  preview,
}: {
  preview: z.infer<typeof importContactPreviewSchema>;
}) {
  const t = useT();
  const tokens = useSemanticTokens();
  const { source, plan } = preview;
  return (
    <Box
      component="article"
      sx={{
        padding: 4,
        border: `1px solid ${tokens['border.default']}`,
        borderRadius: '6px',
        display: 'grid',
        gap: 2,
      }}
    >
      <Typography component="h4" variant="body1" sx={{ fontWeight: 600 }}>
        <bdi>{plan.name}</bdi>
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t(`imports:dryRun.contactActions.${plan.action}`)} · <bdi>{source.externalId}</bdi>
      </Typography>
      <Box component="ul" sx={{ margin: 0, paddingInlineStart: 4 }}>
        {plan.identifiers.map((identifier) => (
          <li key={`${identifier.kind}:${identifier.value}`}>
            <Typography>
              <bdi dir="ltr">{identifier.value}</bdi>
            </Typography>
          </li>
        ))}
      </Box>
      {plan.organization ? (
        <Typography variant="caption">
          {t('imports:dryRun.organization')} <bdi>{plan.organization.name}</bdi> ·{' '}
          {t(`imports:dryRun.contactActions.${plan.organization.action}`)}
        </Typography>
      ) : null}
      {plan.refusedPhones ? (
        <AlertBanner tone="warning">
          {t('imports:dryRun.refusedPhones', { count: plan.refusedPhones })}
        </AlertBanner>
      ) : null}
    </Box>
  );
}
