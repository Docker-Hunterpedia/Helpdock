import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import type { PasswordStrength, SetupAdminRequest } from '@helpdock/schemas';
import { estimatePasswordStrength, PASSWORD_STRENGTHS } from '@helpdock/schemas';
import { Box, Button, OutlinedInput, Select, Typography } from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { Field, fieldDescribedBy } from '../../ui/field.tsx';
import { StepFrame } from './setup-layout.tsx';

/**
 * Step 1 of the artboard `Admin/Wizard`: the install administrator.
 *
 * The language picker changes the app's language as it is chosen rather than on
 * submit, so an operator who picks Arabic sees the rest of the wizard in Arabic
 * and right to left immediately (DESIGN §7). It is also what the new account's
 * `locale` column is set to.
 */

export type PasswordIssue = 'required' | 'short' | 'weak';

/** The same shape as `sign-in-form.ts`: one issue per field, the first one wins. */
export interface AccountStepErrors {
  name?: 'required';
  email?: 'required' | 'invalid';
  password?: PasswordIssue;
}

export interface AccountDraft {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;

export function validateAccount({ name, email, password }: AccountDraft): AccountStepErrors {
  const errors: AccountStepErrors = {};

  if (name.trim() === '') {
    errors.name = 'required';
  }
  if (email.trim() === '') {
    errors.email = 'required';
  } else if (!EMAIL.test(email.trim())) {
    errors.email = 'invalid';
  }

  if (password === '') {
    errors.password = 'required';
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = 'short';
  } else if (estimatePasswordStrength(password).strength === 'weak') {
    // The same rule the api enforces, so the meter never promises something
    // the server then refuses (`@helpdock/schemas/password-strength`).
    errors.password = 'weak';
  }

  return errors;
}

/** Four steps, lit up to the reading. Colour is never the only signal: the word is there too. */
function StrengthMeter({ password }: { readonly password: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { strength, score } = estimatePasswordStrength(password);

  const hue: Record<PasswordStrength, string> = {
    weak: tokens['status.danger'],
    fair: tokens['status.warning'],
    good: tokens['status.success'],
    strong: tokens['status.success'],
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, marginBlockStart: '6px' }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1 }}>
        {PASSWORD_STRENGTHS.map((_step, index) => (
          <Box
            key={PASSWORD_STRENGTHS[index]}
            aria-hidden="true"
            sx={{
              height: 4,
              borderRadius: 2,
              backgroundColor:
                password !== '' && index <= score ? hue[strength] : tokens['border.default'],
            }}
          />
        ))}
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {`${t('wizard:account.strengthLabel')}: ${t(`wizard:account.strength.${strength}`)}`}
      </Typography>
    </Box>
  );
}

export interface AccountStepProps {
  readonly locale: Locale;
  readonly onLocaleChange: (locale: Locale) => void;
  readonly onSubmit: (request: SetupAdminRequest) => void;
  readonly pending: boolean;
}

export function AccountStep({
  locale,
  onLocaleChange,
  onSubmit,
  pending,
}: AccountStepProps): ReactNode {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<AccountStepErrors>({});

  const submit = (): void => {
    const found = validateAccount({ name, email, password });
    setErrors(found);

    if (Object.keys(found).length === 0) {
      onSubmit({ name: name.trim(), email: email.trim(), password, locale });
    }
  };

  const nameError = errors.name ? t('wizard:account.nameRequired') : undefined;
  const emailError =
    errors.email === 'required'
      ? t('wizard:account.emailRequired')
      : errors.email === 'invalid'
        ? t('wizard:account.emailInvalid')
        : undefined;
  const passwordError =
    errors.password === 'required'
      ? t('wizard:account.passwordRequired')
      : errors.password === 'short'
        ? t('wizard:account.passwordTooShort')
        : errors.password === 'weak'
          ? t('wizard:account.passwordTooWeak')
          : undefined;

  return (
    <StepFrame
      title={t('wizard:account.title')}
      description={t('wizard:account.description')}
      onSubmit={submit}
      footer={
        <Button type="submit" variant="contained" color="primary" loading={pending}>
          {t('wizard:account.submit')}
        </Button>
      }
    >
      <Field id="setup-name" label={t('wizard:account.nameLabel')} error={nameError}>
        <OutlinedInput
          id="setup-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          error={Boolean(nameError)}
          fullWidth
          slotProps={{
            input: {
              autoComplete: 'name',
              'aria-describedby': fieldDescribedBy('setup-name', { error: nameError }),
            },
          }}
        />
      </Field>

      <Field id="setup-email" label={t('wizard:account.emailLabel')} error={emailError}>
        <OutlinedInput
          id="setup-email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          error={Boolean(emailError)}
          fullWidth
          slotProps={{
            input: {
              dir: 'ltr',
              autoComplete: 'username',
              'aria-describedby': fieldDescribedBy('setup-email', { error: emailError }),
            },
          }}
        />
      </Field>

      <Box>
        <Field
          id="setup-password"
          label={t('wizard:account.passwordLabel')}
          hint={t('wizard:account.passwordHint')}
          error={passwordError}
        >
          <OutlinedInput
            id="setup-password"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            error={Boolean(passwordError)}
            fullWidth
            slotProps={{
              input: {
                dir: 'ltr',
                autoComplete: 'new-password',
                'aria-describedby': fieldDescribedBy('setup-password', {
                  hint: t('wizard:account.passwordHint'),
                  error: passwordError,
                }),
              },
            }}
          />
        </Field>
        <StrengthMeter password={password} />
      </Box>

      <Field id="setup-locale" label={t('wizard:account.languageLabel')}>
        {/* Native, so the `<label for>` above really labels it and a test can
            pick an option the way a person does. */}
        <Select
          native
          id="setup-locale"
          value={locale}
          onChange={(event) => {
            onLocaleChange(event.target.value as Locale);
          }}
          fullWidth
        >
          {SUPPORTED_LNGS.map((candidate) => (
            <option key={candidate} value={candidate} lang={candidate}>
              {t(`common:language.${candidate}`)}
            </option>
          ))}
        </Select>
      </Field>
    </StepFrame>
  );
}
