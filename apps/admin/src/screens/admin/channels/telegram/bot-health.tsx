import type { TelegramBot, TelegramBotHealthState } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { HEALTH_TEXT } from '../format.js';
import { HealthStateDot } from '../health.tsx';

/**
 * DESIGN §6.2 HealthIndicator for a Telegram bot (M6-05): the dot and the
 * state in words, never the colour alone, in the danger text colour when the
 * bot is failing.
 */
export function BotHealth({ bot }: { readonly bot: Pick<TelegramBot, 'health'> }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { state } = bot.health;
  const text = HEALTH_TEXT[state];

  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <HealthStateDot state={state} />
      <Typography
        component="span"
        sx={{
          fontSize: 13,
          ...(text === undefined ? {} : { color: tokens[text], fontWeight: 500 }),
        }}
      >
        {t(`channels:telegram.health.${state}`)}
      </Typography>
    </Box>
  );
}

const LEGEND: readonly TelegramBotHealthState[] = ['healthy', 'failing', 'waiting'];

export function BotHealthLegend(): ReactNode {
  const t = useT();

  return (
    <Box
      component="ul"
      sx={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      {LEGEND.map((state) => (
        <Box component="li" key={state} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <HealthStateDot state={state} />
          {t(`channels:telegram.legend.${state}`)}
        </Box>
      ))}
    </Box>
  );
}
