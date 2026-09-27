import { Box, OutlinedInput, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * The "Setup key" block at the top of step 1, from the artboard
 * `Admin/Wizard-SetupKey` (#43). Drawn only when the install set
 * `HD_SETUP_TOKEN`.
 *
 * Not built on `Field`, because the artboard keeps the hint on screen under
 * the error — the hint is what tells the operator where the key lives, which
 * is exactly what they need after getting it wrong — and the error line is an
 * alert, since it answers a submit rather than a keystroke.
 */

const INPUT_ID = 'setup-key';
const ERROR_ID = `${INPUT_ID}-error`;
const HINT_ID = `${INPUT_ID}-hint`;

/** The names an operator has to find on the server, set in mono and kept left to right. */
const CODE = /(HD_SETUP_TOKEN|\.env)/;

function WithCode({ text }: { readonly text: string }): ReactNode {
  return text.split(CODE).map((part, index) =>
    index % 2 === 1 ? (
      <Box
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence never reorder.
        key={index}
        component="span"
        dir="ltr"
        sx={{ fontFamily: 'var(--hd-font-mono, monospace)' }}
      >
        {part}
      </Box>
    ) : (
      part
    ),
  );
}

export interface SetupKeyFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Left empty on screen, or refused by the api. */
  readonly error: 'required' | 'invalid' | undefined;
}

export function SetupKeyField({ value, onChange, error }: SetupKeyFieldProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const errorText =
    error === 'required'
      ? t('wizard:account.setupKeyRequired')
      : error === 'invalid'
        ? t('wizard:account.setupKeyInvalid')
        : undefined;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        paddingBlock: 3,
        paddingInline: 4,
        borderRadius: '6px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Typography
        component="label"
        htmlFor={INPUT_ID}
        sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px' }}
      >
        {t('wizard:account.setupKeyLabel')}
      </Typography>
      <OutlinedInput
        id={INPUT_ID}
        type="password"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        error={errorText !== undefined}
        fullWidth
        slotProps={{
          input: {
            dir: 'ltr',
            autoComplete: 'off',
            spellCheck: false,
            'aria-invalid': errorText !== undefined,
            'aria-describedby': errorText === undefined ? HINT_ID : `${ERROR_ID} ${HINT_ID}`,
            style: { fontFamily: 'var(--hd-font-mono, monospace)' },
          },
        }}
      />
      {errorText === undefined ? null : (
        <Typography
          id={ERROR_ID}
          role="alert"
          variant="caption"
          sx={{ color: tokens['status.danger.text'] }}
        >
          <WithCode text={errorText} />
        </Typography>
      )}
      <Typography id={HINT_ID} variant="caption" sx={{ color: 'text.secondary' }}>
        <WithCode text={t('wizard:account.setupKeyHint')} />
      </Typography>
    </Box>
  );
}
