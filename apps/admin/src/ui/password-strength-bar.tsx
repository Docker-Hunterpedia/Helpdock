import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useSemanticTokens } from '../app/tokens.js';
import type { PasswordStrength } from './password-strength.js';

/**
 * The four-segment bar under a password field.
 *
 * It is decorative: the same judgement is in the field's hint as words, which
 * is what a screen reader reads and what somebody who cannot tell the hues
 * apart relies on (DESIGN §10, "never colour alone"). So the bar is
 * `aria-hidden` rather than given a label that would say the sentence twice.
 */
export function PasswordStrengthBar({
  strength,
  refused = false,
}: {
  readonly strength: PasswordStrength;
  /** The api refused the password: one danger segment, whatever it looked like. */
  readonly refused?: boolean;
}): ReactNode {
  const tokens = useSemanticTokens();
  const score = refused ? 0 : strength.score;

  const hue = refused
    ? tokens['status.danger']
    : strength.score >= 3
      ? tokens['status.success']
      : strength.score === 2
        ? tokens['status.info']
        : strength.score === 1
          ? tokens['status.warning']
          : tokens['status.danger'];

  return (
    <Box
      aria-hidden="true"
      sx={{ display: 'flex', gap: 1, marginBlockStart: '6px' }}
      data-strength={refused ? 'refused' : strength.level}
    >
      {[0, 1, 2, 3].map((segment) => (
        <Box
          key={segment}
          sx={{
            height: 4,
            flex: 1,
            borderRadius: '2px',
            backgroundColor: segment <= score ? hue : tokens['border.default'],
          }}
        />
      ))}
    </Box>
  );
}
