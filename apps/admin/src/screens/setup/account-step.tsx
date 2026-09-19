import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import type { SetupAdminRequest } from '@helpdock/schemas';
import { PASSWORD_MIN_LENGTH } from '@helpdock/schemas';
import { Box, Button, OutlinedInput, Select } from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Field, fieldDescribedBy } from '../../ui/field.tsx';
import { passwordStrength } from '../../ui/password-strength.js';
import { PasswordStrengthBar } from '../../ui/password-strength-bar.tsx';
import { StepFrame } from './setup-layout.tsx';

/**
 * Step 1 of the artboard `Admin/Wizard`: the install administrator.
 *
 * The language picker changes the app's language as it is chosen rather than on
 * submit, so an operator who picks Arabic sees the rest of the wizard in Arabic
 * and right to left immediately (DESIGN §7). It is also what the new account's
 * `locale` column is set to.
 */

/** The same shape as `sign-in-form.ts`: one issue per field, the first one wins. */
export interface AccountStepErrors {
  name?: 'required';
  email?: 'required' | 'invalid';
  password?: 'required' | 'short';
}

export interface AccountDraft {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  // Length is the only rule, and it is the one the api enforces too: the bar
  // below the field is a hint, never a second policy (M0-06,
  // `ui/password-strength.ts`).
  if (password === '') {
    errors.password = 'required';
  } else if (password.length < PASSWORD_MIN_LENGTH) {
    errors.password = 'short';
  }

  return errors;
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
  const strength = passwordStrength(password);

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
        ? t('wizard:account.passwordTooShort', { count: PASSWORD_MIN_LENGTH })
        : undefined;
  // The bar is decorative, so the reading is said in the hint, which is what
  // `aria-describedby` points at (M0-06, `ui/password-strength-bar.tsx`).
  const passwordHint = t('wizard:account.passwordHint', {
    count: PASSWORD_MIN_LENGTH,
    strength: t(`wizard:account.strength.${strength.level}`),
  });

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
          hint={passwordHint}
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
                  hint: passwordHint,
                  error: passwordError,
                }),
              },
            }}
          />
        </Field>
        <PasswordStrengthBar strength={strength} />
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
