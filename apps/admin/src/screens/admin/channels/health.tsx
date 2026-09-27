import type { Mailbox, MailboxHealthState } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { HEALTH_TEXT, HEALTH_TOKEN, healthLabelKey } from './format.js';

/**
 * DESIGN §6.2 HealthIndicator: an 8 px dot in the state's hue and the state
 * in words beside it — never the colour alone (DESIGN §10). A failure names
 * itself ("IMAP sign-in failed") in the danger text colour.
 */

const DOT = 8;

function Dot({ state }: { readonly state: MailboxHealthState }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        width: DOT,
        height: DOT,
        borderRadius: '999px',
        flexShrink: 0,
        backgroundColor: tokens[HEALTH_TOKEN[state]],
      }}
    />
  );
}

export function HealthDot({ mailbox }: { readonly mailbox: Pick<Mailbox, 'health'> }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { state } = mailbox.health;
  const text = HEALTH_TEXT[state];

  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <Dot state={state} />
      <Typography
        component="span"
        sx={{
          fontSize: 13,
          ...(text === undefined ? {} : { color: tokens[text], fontWeight: 500 }),
        }}
      >
        {t(healthLabelKey(mailbox))}
      </Typography>
    </Box>
  );
}

const LEGEND: readonly MailboxHealthState[] = ['healthy', 'behind', 'failing', 'waiting'];

export function HealthLegend(): ReactNode {
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
          <Dot state={state} />
          {t(`channels:legend.${state}`)}
        </Box>
      ))}
    </Box>
  );
}
