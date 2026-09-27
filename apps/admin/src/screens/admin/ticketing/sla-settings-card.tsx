import type { BrandSettings, TicketStatus } from '@helpdock/schemas';
import { Box, FormControlLabel, Link, Radio, RadioGroup, Switch, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { ticketingRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { statusName } from '../../tickets/format.js';

/**
 * "For every policy" (M3-02): the brand settings that apply whichever policy a
 * ticket uses — whether an AI auto-reply counts as a first response, which
 * statuses pause the clocks (read here, changed on the Statuses tab), what a
 * reopen does, and which clocks compliance reports count. Each control saves
 * as it changes: they are independent switches, not a form.
 */
export function SlaSettingsCard({
  settings,
  statuses,
  busy,
  onChange,
}: {
  readonly settings: BrandSettings;
  readonly statuses: readonly TicketStatus[];
  readonly busy: boolean;
  onChange(
    patch: Pick<Partial<BrandSettings>, 'aiCountsAsFirstResponse' | 'slaCountReopens'>,
  ): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const pausing = statuses.filter((status) => status.pausesSla);
  const reopen = settings.reopenPolicy;
  const divider = {
    borderBlockStart: `1px solid ${tokens['border.default']}`,
    paddingBlockStart: 4,
  };

  return (
    <Box
      component="section"
      aria-labelledby="sla-every-policy"
      sx={{
        padding: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box>
        <Typography variant="bodyStrong" component="h3" id="sla-every-policy">
          {t('ticketing:slas.settings.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('ticketing:slas.settings.caption')}
        </Typography>
      </Box>

      <FormControlLabel
        sx={{ alignItems: 'flex-start', marginInline: 0, gap: 1 }}
        control={
          <Switch
            checked={settings.aiCountsAsFirstResponse}
            disabled={busy}
            onChange={(event) => {
              onChange({ aiCountsAsFirstResponse: event.target.checked });
            }}
            slotProps={{ input: { role: 'switch' } }}
          />
        }
        label={
          <Box component="span" sx={{ display: 'flex', flexDirection: 'column' }}>
            <Typography component="span" variant="bodyStrong">
              {t('ticketing:slas.settings.ai')}
            </Typography>
            <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
              {t('ticketing:slas.settings.aiHint')}
            </Typography>
          </Box>
        }
      />

      <Box sx={{ ...divider, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" component="h4" sx={{ fontWeight: 500 }}>
          {t('ticketing:slas.settings.pauseHeading')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {pausing.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('ticketing:slas.settings.pauseNone')}
            </Typography>
          ) : (
            pausing.map((status) => (
              <Box
                component="span"
                key={status.id}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 1,
                  paddingInline: 2,
                  blockSize: 22,
                  borderRadius: '11px',
                  backgroundColor: tokens['status.warning.tint'],
                  color: tokens['status.warning.text'],
                  fontSize: 12,
                }}
              >
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{
                    inlineSize: 6,
                    blockSize: 6,
                    borderRadius: '50%',
                    backgroundColor: tokens['status.warning'],
                  }}
                />
                {statusName(status, locale)}
              </Box>
            ))
          )}
          <Link component={RouterLink} to={ticketingRoute('statuses')} variant="body2">
            {t('ticketing:slas.settings.change')}
          </Link>
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:slas.settings.pauseHint')}
        </Typography>
      </Box>

      <Box sx={{ ...divider, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body2" component="h4" sx={{ fontWeight: 500 }}>
          {t('ticketing:slas.settings.reopenHeading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:slas.settings.reopenBody')}{' '}
          {reopen.kind === 'within_days'
            ? t('ticketing:slas.settings.reopenWithin', { days: reopen.days })
            : t(`ticketing:slas.settings.reopen.${reopen.kind}`)}
        </Typography>
      </Box>

      <Box component="fieldset" sx={{ ...divider, border: 0, margin: 0, paddingInline: 0 }}>
        <Typography
          component="legend"
          variant="body2"
          sx={{ fontWeight: 500, float: 'inline-start', inlineSize: '100%' }}
        >
          {t('ticketing:slas.settings.compliance')}
        </Typography>
        <RadioGroup
          value={settings.slaCountReopens ? 'reopens' : 'initial'}
          onChange={(event) => {
            onChange({ slaCountReopens: event.target.value === 'reopens' });
          }}
        >
          <FormControlLabel
            value="initial"
            disabled={busy}
            control={<Radio size="small" />}
            label={t('ticketing:slas.settings.initialOnly')}
          />
          <FormControlLabel
            value="reopens"
            disabled={busy}
            control={<Radio size="small" />}
            label={t('ticketing:slas.settings.countReopens')}
          />
        </RadioGroup>
      </Box>
    </Box>
  );
}
