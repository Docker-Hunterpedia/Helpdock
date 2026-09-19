import { Box, Button, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { StepFrame } from './setup-layout.tsx';
import type { SetupSummary } from './setup-state.js';

/**
 * Step 4 of the artboard `Admin/Wizard`: what was created, and the way in.
 *
 * There is no "Back" here. The account and the brand exist by now, and a button
 * that looked as if it could take them away would be a lie; everything on this
 * card is changed in Settings from now on.
 */

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 4,
        paddingBlock: 3,
        borderBlockEnd: `1px solid ${tokens['border.default']}`,
        '&:last-of-type': { borderBlockEnd: 'none' },
      }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography
        variant={mono ? 'mono' : 'body2'}
        component="span"
        {...(mono ? { dir: 'ltr' as const } : {})}
        sx={{ textAlign: 'end' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

export interface DoneStepProps {
  readonly summary: SetupSummary;
  /** The install requires a second factor, so enrolment comes before the shell. */
  readonly require2fa: boolean;
  readonly onOpen: () => void;
  readonly pending: boolean;
}

export function DoneStep({ summary, require2fa, onOpen, pending }: DoneStepProps): ReactNode {
  const t = useT();

  return (
    <StepFrame
      title={t('wizard:done.title')}
      description={t('wizard:done.description')}
      onSubmit={onOpen}
      footer={
        <Button type="submit" variant="contained" color="primary" loading={pending}>
          {t('wizard:done.submit')}
        </Button>
      }
    >
      {require2fa ? <AlertBanner tone="info">{t('wizard:done.twoFactor')}</AlertBanner> : null}

      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        <SummaryRow label={t('wizard:done.adminLabel')} value={summary.adminEmail} mono />
        <SummaryRow
          label={t('wizard:done.brandLabel')}
          value={t('wizard:done.brandValue', {
            name: summary.brandName,
            prefix: summary.brandPrefix,
          })}
        />
        <SummaryRow
          label={t('wizard:done.emailLabel')}
          value={summary.smtpHost ?? t('wizard:done.emailSkipped')}
          mono={summary.smtpHost !== null}
        />
      </Box>
    </StepFrame>
  );
}
