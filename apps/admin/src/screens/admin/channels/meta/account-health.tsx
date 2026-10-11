import type { MetaAccount } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { HEALTH_TEXT } from '../format.js';
import { HealthStateDot } from '../health.tsx';

/**
 * DESIGN §6.2 HealthIndicator for a Meta account (M10-07, M10-10): the dot and
 * the state in words, never the colour alone, with the failure named when
 * there is one ("Token expired").
 *
 * The api's health is three states; the fourth, Expiring, is read here from
 * the token's date. Helpdock renews an Instagram token once it is a week old,
 * so one that has less than a week left is one the renewal could not reach.
 */

export type AccountHealthView = 'healthy' | 'expiring' | 'failing' | 'waiting';

/** How close to its end an Instagram token is called Expiring. */
export const EXPIRING_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

type HealthFacts = Pick<MetaAccount, 'health' | 'tokenExpiresAt'>;

export const accountHealthView = (account: HealthFacts, now: number): AccountHealthView => {
  if (account.health === 'failing') {
    return 'failing';
  }
  if (
    account.tokenExpiresAt !== null &&
    Date.parse(account.tokenExpiresAt) - now < EXPIRING_WITHIN_MS
  ) {
    return 'expiring';
  }
  return account.health;
};

type HealthWord = AccountHealthView | 'tokenExpired' | 'unsubscribed';

/** The word a row says: the failure itself, when Helpdock knows which one it is. */
export const accountHealthWord = (
  account: Pick<MetaAccount, 'health' | 'status' | 'tokenExpiresAt'>,
  now: number,
): HealthWord => {
  const view = accountHealthView(account, now);
  if (view === 'failing' && account.status === 'token_expired') {
    return 'tokenExpired';
  }
  if (view === 'failing' && account.status === 'unsubscribed') {
    return 'unsubscribed';
  }
  return view;
};

/** The dots are the mailbox ones; Expiring is the warning hue, which Behind is. */
const DOT_STATE = {
  healthy: 'healthy',
  expiring: 'behind',
  failing: 'failing',
  waiting: 'waiting',
} as const;

export function AccountHealth({
  account,
  now,
}: {
  readonly account: Pick<MetaAccount, 'health' | 'status' | 'tokenExpiresAt'>;
  readonly now: number;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const view = accountHealthView(account, now);
  const text = HEALTH_TEXT[DOT_STATE[view]];

  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <HealthStateDot state={DOT_STATE[view]} />
      <Typography
        component="span"
        sx={{
          fontSize: 13,
          ...(text === undefined ? {} : { color: tokens[text], fontWeight: 500 }),
        }}
      >
        {t(`channels:meta.health.${accountHealthWord(account, now)}`)}
      </Typography>
    </Box>
  );
}

const LEGEND: readonly AccountHealthView[] = ['healthy', 'expiring', 'failing', 'waiting'];

export function AccountHealthLegend(): ReactNode {
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
          <HealthStateDot state={DOT_STATE[state]} />
          {t(`channels:meta.legend.${state}`)}
        </Box>
      ))}
    </Box>
  );
}
