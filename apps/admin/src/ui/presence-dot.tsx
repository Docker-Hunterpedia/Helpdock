import type { PresenceStatus } from '@helpdock/schemas';
import type { SemanticTokens } from '@helpdock/ui';
import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.2: "PresenceDot — 8 px: online success, away warning, offline n400."
 *
 * The dot is never the only carrier of the meaning: the caller always renders
 * the translated status beside it, so the component is `aria-hidden` and the
 * colour is decoration. `data-status` is what the browser tests assert on,
 * because a computed colour is a brittle thing to compare.
 */

export const PRESENCE_DOT_SIZE = 8;

const colorOf = (tokens: SemanticTokens, status: PresenceStatus): string => {
  switch (status) {
    case 'online':
      return tokens['status.success'];
    case 'away':
      return tokens['status.warning'];
    case 'offline':
      // n400 in the light ramp, and the disabled text colour in both.
      return tokens['text.disabled'];
  }
};

export function PresenceDot({ status }: { readonly status: PresenceStatus }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="span"
      aria-hidden="true"
      data-status={status}
      sx={{
        width: PRESENCE_DOT_SIZE,
        height: PRESENCE_DOT_SIZE,
        borderRadius: '50%',
        flexShrink: 0,
        display: 'inline-block',
        backgroundColor: colorOf(tokens, status),
      }}
    />
  );
}
