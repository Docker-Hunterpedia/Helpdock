import type { Locale } from '@helpdock/i18n';
import { SUPPORTED_LNGS } from '@helpdock/i18n';
import type { SetupAdminRequest } from '@helpdock/schemas';
import { PASSWORD_MIN_LENGTH } from '@helpdock/schemas';
import { Button, OutlinedInput, Select } from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Field, fieldDescribedBy } from '../../ui/field.tsx';
import { PasswordField } from '../../ui/password-field.tsx';
import { passwordStrength } from '../../ui/password-strength.js';
import { SetupKeyField } from './setup-key-field.tsx';
import { StepFrame } from './setup-layout.tsx';

/**
 * Step 1 of the artboard `Admin/Wizard`: the install administrator.
 *
 * The language picker changes the app's language as it is chosen rather than on
 * submit, so an operator who picks Arabic sees the rest of the wizard in Arabic
 * and right to left immediately (DESIGN §7). It is also what the new account's
 * `locale` column is set to.
 *
 * When the install set `HD_SETUP_TOKEN`, the step opens with a "Setup key"
 * block (`Admin/Wizard-SetupKey`, #43); without it the step asks for nothing
 * more than it always did.
 */

/** The same shape as `sign-in-form.ts`: one issue per field, the first one wins. */
export interface AccountStepErrors {
  name?: 'required';
  email?: 'required' | 'invalid';
  password?: 'required' | 'short';
  setupKey?: 'required';
}

export interface AccountDraft {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  /** Only looked at when the install asks for one. */
  readonly setupKey?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAccount(
  { name, email, password, setupKey = '' }: AccountDraft,
  { setupKeyRequired = false }: { readonly setupKeyRequired?: boolean } = {},
): AccountStepErrors {
  const errors: AccountStepErrors = {};

  if (setupKeyRequired && setupKey.trim() === '') {
    errors.setupKey = 'required';
  }
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
  /** Whether this install set `HD_SETUP_TOKEN`, so the step asks for it. */
  readonly setupKeyRequired?: boolean;
  /** The api refused the key that was sent; drawn under the field. */
  readonly setupKeyRefused?: boolean;
  /** The api found the password on its breached-password list (ASVS 2.1.7). */
  readonly passwordBreached?: boolean;
}

export function AccountStep({
  locale,
  onLocaleChange,
  onSubmit,
  pending,
  setupKeyRequired = false,
  setupKeyRefused = false,
  passwordBreached = false,
}: AccountStepProps): ReactNode {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [errors, setErrors] = useState<AccountStepErrors>({});
  const strength = passwordStrength(password);

  const submit = (): void => {
    const found = validateAccount({ name, email, password, setupKey }, { setupKeyRequired });
    setErrors(found);

    if (Object.keys(found).length === 0) {
      onSubmit({
        name: name.trim(),
        email: email.trim(),
        password,
        locale,
        ...(setupKeyRequired ? { setupKey: setupKey.trim() } : {}),
      });
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
      {setupKeyRequired ? (
        <SetupKeyField
          value={setupKey}
          onChange={setSetupKey}
          error={errors.setupKey ?? (setupKeyRefused ? 'invalid' : undefined)}
        />
      ) : null}

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

      <PasswordField
        id="setup-password"
        label={t('wizard:account.passwordLabel')}
        value={password}
        onChange={setPassword}
        hint={passwordHint}
        refusal={
          passwordError !== undefined
            ? { kind: 'short', message: passwordError }
            : passwordBreached
              ? { kind: 'breached' }
              : null
        }
      />

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
