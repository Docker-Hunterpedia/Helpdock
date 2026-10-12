import type { MetaAccount } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { CircleDollarSign, Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { FormSection } from '../telegram/form-section.tsx';
import { MetaNote, NoteText } from './meta-note.tsx';

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
          typography: 'body2',
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
              <Typography variant="mono" component="bdi">
                {account.wabaId}
              </Typography>
            </dd>
          </>
        )}
      </Box>

      <MetaNote icon={<CircleDollarSign size={16} aria-hidden="true" />}>
        <NoteText>
          <strong>{t('channels:meta.detail.number.chargeLead')}</strong>{' '}
          {t('channels:meta.detail.number.charge')}
        </NoteText>
      </MetaNote>
      <MetaNote icon={<Clock size={16} aria-hidden="true" />}>
        <NoteText>
          <strong>{t('channels:meta.detail.number.noHumanLead')}</strong>{' '}
          {t('channels:meta.detail.number.noHuman')}
        </NoteText>
      </MetaNote>
    </FormSection>
  );
}
