import { Box, IconButton, InputAdornment, OutlinedInput, Typography } from '@mui/material';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { Field } from './field.tsx';
import { passwordStrength } from './password-strength.js';
import { PasswordStrengthBar } from './password-strength-bar.tsx';

/**
 * `Admin/PasswordField` (DESIGN §6, ASVS 2.1.8 and 2.1.12): the Input every
 * screen that *chooses* a password uses — accepting an invitation, a reset,
 * Account › Security and the wizard's admin step. Signing in keeps a plain
 * field; there is nothing to judge about a password that already exists.
 *
 * - **Show / hide.** A ghost IconButton at the Input's inline end, with
 *   `aria-pressed`. Shown text is mono so `l`, `1` and `I` can be told apart.
 *   Sending the form hides it again, so a password is never left on screen
 *   behind a success message.
 * - **Strength.** The PasswordStrengthBar, read aloud through the hint.
 * - **The api's refusal.** A screen passes `refusal` once the api has
 *   answered — never while typing. The hint becomes the error with
 *   `role="alert"`, the Input is `aria-invalid`, and the bar drops to one
 *   danger segment. A breach-list match also says where the check ran.
 */

export type PasswordRefusal =
  /** Under the twelve-character floor. */
  | { readonly kind: 'short'; readonly message: string }
  /** On the bundled breached-password list (`password-breached`). */
  | { readonly kind: 'breached' };

export interface PasswordFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The sentence under the field while nothing is wrong, strength included. */
  readonly hint: string;
  readonly refusal?: PasswordRefusal | null | undefined;
  readonly autoFocus?: boolean | undefined;
}

const errorId = (id: string): string => `${id}-error`;
const hintId = (id: string): string => `${id}-hint`;

export function PasswordField({
  id,
  label,
  value,
  onChange,
  hint,
  refusal = null,
  autoFocus = false,
}: PasswordFieldProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  const hide = useCallback(() => {
    setShown(false);
  }, []);

  // The form the field sits in, whichever screen it is: its submit is the
  // moment the password stops needing to be read.
  useEffect(() => {
    const form = input.current?.form;
    form?.addEventListener('submit', hide);
    return () => {
      form?.removeEventListener('submit', hide);
    };
  }, [hide]);

  const message =
    refusal === null
      ? null
      : refusal.kind === 'short'
        ? refusal.message
        : t('auth:passwordField.breached');

  return (
    <Field id={id} label={label}>
      <OutlinedInput
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        error={message !== null}
        fullWidth
        inputRef={input}
        endAdornment={
          <InputAdornment position="end">
            <IconButton
              size="small"
              aria-pressed={shown}
              aria-label={shown ? t('auth:passwordField.hide') : t('auth:passwordField.show')}
              aria-controls={id}
              onClick={() => {
                setShown((current) => !current);
              }}
              sx={{ width: 32, height: 32 }}
            >
              {shown ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </IconButton>
          </InputAdornment>
        }
        slotProps={{
          input: {
            dir: 'ltr',
            autoComplete: 'new-password',
            autoFocus,
            maxLength: 200,
            'aria-invalid': message !== null,
            'aria-describedby': message === null ? hintId(id) : errorId(id),
            style: shown ? { fontFamily: 'var(--hd-font-mono, monospace)' } : undefined,
          },
        }}
      />
      <PasswordStrengthBar strength={passwordStrength(value)} refused={message !== null} />
      {message === null ? (
        <Typography
          id={hintId(id)}
          variant="caption"
          sx={{ marginBlockStart: '6px', color: 'text.secondary' }}
        >
          {hint}
        </Typography>
      ) : (
        <Box id={errorId(id)} sx={{ marginBlockStart: '6px' }}>
          <Typography
            role="alert"
            variant="caption"
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '6px',
              color: tokens['status.danger.text'],
            }}
          >
            <AlertCircle
              size={14}
              aria-hidden="true"
              style={{ flexShrink: 0, marginBlockStart: 2 }}
            />
            <span>{message}</span>
          </Typography>
          {refusal?.kind === 'breached' ? (
            <Typography
              variant="caption"
              component="p"
              sx={{ color: 'text.secondary', marginBlockStart: '4px' }}
            >
              {t('auth:passwordField.breachedNote')}
            </Typography>
          ) : null}
        </Box>
      )}
    </Field>
  );
}
