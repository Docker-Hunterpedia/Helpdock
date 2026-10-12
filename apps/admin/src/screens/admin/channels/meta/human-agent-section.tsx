import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { Switch } from '../../../../ui/switch.tsx';
import { FormSection } from '../telegram/form-section.tsx';
import { CodeText } from './code-text.tsx';

/**
 * Human Agent (M10-07, Messenger and Instagram only, said by a Label): a Switch
 * that lets a person answer for seven days after the customer's last message
 * instead of twenty-four hours. Helpdock cannot ask Meta whether it approved
 * the feature for the app, so turning the switch on is the operator saying it
 * did, and the caption says so.
 */
export function HumanAgentSection({
  enabled,
  onChange,
}: {
  readonly enabled: boolean;
  onChange(enabled: boolean): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <FormSection
      heading={t('channels:meta.detail.humanAgent.heading')}
      caption={t('channels:meta.detail.humanAgent.caption')}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
        <Switch
          checked={enabled}
          label={t('channels:meta.detail.humanAgent.switch')}
          onChange={onChange}
        />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <Typography component="span" variant="bodyStrong" aria-hidden="true">
            {t('channels:meta.detail.humanAgent.switch')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            <CodeText text={t('channels:meta.detail.humanAgent.body')} />
          </Typography>
          <Box
            component="ul"
            sx={{
              margin: 0,
              paddingInlineStart: 5,
              typography: 'body2',
              color: 'text.secondary',
              '& li + li': { marginBlockStart: 1 },
            }}
          >
            <li>{t('channels:meta.detail.humanAgent.personOnly')}</li>
            <li>{t('channels:meta.detail.humanAgent.restricted')}</li>
          </Box>
        </Box>
        <Box
          component="span"
          sx={{
            marginInlineStart: 'auto',
            paddingInline: 2,
            height: 20,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: '6px',
            typography: 'caption',
            whiteSpace: 'nowrap',
            color: 'text.secondary',
            backgroundColor: tokens['bg.muted'],
          }}
        >
          {t('channels:meta.detail.humanAgent.label')}
        </Box>
      </Box>
    </FormSection>
  );
}
