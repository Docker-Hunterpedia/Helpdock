import type { MetaAccount } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { CircleDollarSign, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { FormSection } from '../telegram/form-section.tsx';

/**
 * Number (M10-07, WhatsApp only): what Meta reports about the number, and the
 * two notes an operator needs before the first reply — Meta may charge for each
 * delivered message, and there is no Human Agent window on WhatsApp.
 */
export function NumberSection({
  account,
}: {
  readonly account: Pick<MetaAccount, 'displayName' | 'displayPhone' | 'wabaId'>;
}): ReactNode {
  const t = useT();

  return (
    <FormSection
      heading={t('channels:meta.detail.number.heading')}
      caption={t('channels:meta.detail.number.caption')}
    >
      <Box
        component="dl"
        sx={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, max-content) minmax(0, 1fr)',
          columnGap: 6,
          rowGap: 2,
          fontSize: 13,
          '& dt': { color: 'text.secondary' },
          '& dd': { margin: 0, minWidth: 0 },
        }}
      >
        <dt>{t('channels:meta.detail.number.displayName')}</dt>
        <dd>
          <bdi>{account.displayName}</bdi>
        </dd>
        {account.displayPhone === null ? null : (
          <>
            <dt>{t('channels:meta.detail.number.phone')}</dt>
            <dd>
              <bdi>{account.displayPhone}</bdi>
            </dd>
          </>
        )}
        {account.wabaId === null ? null : (
          <>
            <dt>{t('channels:meta.detail.number.waba')}</dt>
            <dd>
              <Typography variant="mono" component="bdi" sx={{ fontSize: 12 }}>
                {account.wabaId}
              </Typography>
            </dd>
          </>
        )}
      </Box>

      <Note icon={<CircleDollarSign size={16} aria-hidden="true" />}>
        <strong>{t('channels:meta.detail.number.chargeLead')}</strong>{' '}
        {t('channels:meta.detail.number.charge')}
      </Note>
      <Note icon={<Clock size={16} aria-hidden="true" />}>
        <strong>{t('channels:meta.detail.number.noHumanLead')}</strong>{' '}
        {t('channels:meta.detail.number.noHuman')}
      </Note>
    </FormSection>
  );
}

/** A `role="note"` box on `bg.canvas`: a fact beside the form, not a status. */
function Note({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      role="note"
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        padding: 3,
        borderRadius: '6px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
        fontSize: 13,
        lineHeight: '18px',
        color: 'text.secondary',
        '& strong': { color: 'text.primary' },
      }}
    >
      <Box component="span" sx={{ flexShrink: 0, marginBlockStart: '1px', display: 'inline-flex' }}>
        {icon}
      </Box>
      <Typography variant="body2" sx={{ color: 'inherit', fontSize: 13, lineHeight: '18px' }}>
        {children}
      </Typography>
    </Box>
  );
}
