import {
  PASSKEY_NAME_MAX_LENGTH,
  type PasskeyEnrolmentRequest,
  passkeyNameSchema,
  type RegistrationResponse,
} from '@helpdock/schemas';
import { Box, Button, Chip, Link, OutlinedInput, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, Smartphone } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { isAuthError } from '../auth/api.js';
import { retryAfterMinutes } from '../auth/auth-error.js';
import {
  createPasskey,
  isPasskeyCeremonyError,
  passkeysSupported,
} from '../auth/passkey-ceremony.js';
import { useAuthApi } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../ui/field.tsx';
import { RadioCard } from '../ui/radio-card.tsx';
import { AuthLayout } from './auth-layout.tsx';

/**
 * `Admin/Enrol2FA-Choose` (M18-03): where an enrolment challenge starts. Two
 * radio cards, a passkey first and marked Recommended, then Continue. Choosing
 * an authenticator app hands over to today's QR step; choosing a passkey runs
 * the browser prompt and moves on to naming it.
 *
 * A browser that cannot create passkeys, or an install that has paused them,
 * disables the passkey card with the reason as its description and
 * preselects the app, so nobody is offered a path that cannot finish.
 */

type Method = 'passkey' | 'app';

/** What the browser made, held until the person has named it. */
export interface PromptedPasskey {
  readonly ceremonyId: string;
  readonly response: RegistrationResponse;
}

export function EnrolmentChoose({
  challengeId,
  onApp,
  onPrompted,
  onSignOut,
}: {
  readonly challengeId: string;
  readonly onApp: () => void;
  readonly onPrompted: (prompted: PromptedPasskey) => void;
  readonly onSignOut: () => void;
}): ReactNode {
  const t = useT();
  const api = useAuthApi();
  const id = useId();
  const supported = passkeysSupported();
  const methods = useQuery({ queryKey: ['auth', 'methods'], queryFn: () => api.authMethods() });
  const installAllows = methods.data?.passkey !== false;
  const available = supported && installAllows;
  const [chosen, setChosen] = useState<Method | null>(null);
  const method: Method = chosen ?? (available ? 'passkey' : 'app');
  const [notice, setNotice] = useState<string | null>(null);

  const prompt = useMutation({
    mutationFn: async (): Promise<PromptedPasskey> => {
      const { ceremonyId, options } = await api.startPasskeyEnrolment(challengeId);
      return { ceremonyId, response: await createPasskey(options) };
    },
    onSuccess: onPrompted,
    onError: (error: unknown) => {
      if (isPasskeyCeremonyError(error)) {
        setNotice(
          t(
            error.reason === 'cancelled'
              ? 'auth:enrolment.choose.cancelled'
              : error.reason === 'duplicate'
                ? 'me:passkeys.duplicate'
                : error.reason === 'unsupported'
                  ? 'auth:enrolment.choose.unsupported'
                  : 'auth:enrolment.choose.failed',
          ),
        );
        return;
      }
      if (isAuthError(error)) {
        switch (error.code) {
          case 'passkeys-rp-changed':
          case 'passkeys-unavailable':
            setNotice(t('auth:enrolment.choose.unavailable'));
            return;
          case 'challenge-expired':
            setNotice(t('auth:enrolment.choose.expired'));
            return;
          case 'rate-limited':
            setNotice(t('auth:signIn.rateLimited', { count: retryAfterMinutes(error.retryAfter) }));
            return;
        }
      }
      setNotice(t('auth:enrolment.choose.failed'));
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setNotice(null);
    if (method === 'app') {
      onApp();
      return;
    }
    prompt.mutate();
  };

  return (
    <AuthLayout
      title={t('auth:enrolment.choose.title')}
      subtitle={t('auth:enrolment.choose.body')}
      width={520}
    >
      <Box
        component="form"
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('auth:enrolment.choose.step')}
        </Typography>

        <Box component="fieldset" sx={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
          <Typography
            component="legend"
            sx={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              clipPath: 'inset(50%)',
            }}
          >
            {t('auth:enrolment.choose.groupLabel')}
          </Typography>
          <Box
            role="radiogroup"
            aria-label={t('auth:enrolment.choose.groupLabel')}
            sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
          >
            <RadioCard
              id={`${id}-passkey`}
              name={`${id}-method`}
              value="passkey"
              checked={method === 'passkey'}
              disabled={!available}
              icon={<KeyRound size={16} />}
              title={t('auth:enrolment.choose.passkeyTitle')}
              tag={
                <Chip
                  size="small"
                  color="primary"
                  variant="outlined"
                  label={t('auth:enrolment.choose.recommended')}
                />
              }
              description={
                available
                  ? t('auth:enrolment.choose.passkeyBody')
                  : supported
                    ? t('auth:enrolment.choose.unavailable')
                    : t('auth:enrolment.choose.unsupported')
              }
              onSelect={() => {
                setChosen('passkey');
              }}
            />
            <RadioCard
              id={`${id}-app`}
              name={`${id}-method`}
              value="app"
              checked={method === 'app'}
              icon={<Smartphone size={16} />}
              title={t('auth:enrolment.choose.appTitle')}
              description={t('auth:enrolment.choose.appBody')}
              onSelect={() => {
                setChosen('app');
              }}
            />
          </Box>
        </Box>

        {notice ? <AlertBanner tone="info">{notice}</AlertBanner> : null}

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 3,
          }}
        >
          <Link component="button" type="button" variant="caption" onClick={onSignOut}>
            {t('auth:enrolment.step1.signOut')}
          </Link>
          <Button type="submit" variant="contained" loading={prompt.isPending}>
            {t('auth:enrolment.choose.continue')}
          </Button>
        </Box>
      </Box>
    </AuthLayout>
  );
}

const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone|iPad/, 'iPhone'],
  [/Android/, 'Android'],
  [/Macintosh|Mac OS/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux|CrOS/, 'Linux'],
];

/** A name for the passkey the browser just made, from the device it is on, for the person to keep or change. */
const suggestName = (t: ReturnType<typeof useT>, response: RegistrationResponse): string => {
  const agent = globalThis.navigator?.userAgent ?? '';
  const platform = PLATFORMS.find(([pattern]) => pattern.test(agent))?.[1];
  const name =
    response.authenticatorAttachment === 'cross-platform' || platform === undefined
      ? t('auth:enrolment.choose.nameKey')
      : t('auth:enrolment.choose.nameDefault', { platform });
  return [...name].slice(0, PASSKEY_NAME_MAX_LENGTH).join('');
};

/**
 * "Name this passkey": the second half of the passkey path. The browser has
 * already made the credential; nothing reaches the api until Continue, so a
 * person who walks away here has saved nothing.
 */
export function EnrolmentName({
  prompted,
  failure,
  pending,
  onSubmit,
  onSignOut,
}: {
  readonly prompted: PromptedPasskey;
  /** The api's refusal of the last Continue, already worded. */
  readonly failure: string | null;
  readonly pending: boolean;
  readonly onSubmit: (request: PasskeyEnrolmentRequest) => void;
  readonly onSignOut: () => void;
}): ReactNode {
  const t = useT();
  const fieldId = useId();
  const [name, setName] = useState(() => suggestName(t, prompted.response));
  const [invalid, setInvalid] = useState<string | null>(null);
  const hint = t('auth:enrolment.choose.nameHint');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = passkeyNameSchema.safeParse(name);
    if (!parsed.success) {
      setInvalid(t('auth:enrolment.choose.nameRequired'));
      return;
    }
    setInvalid(null);
    onSubmit({
      ceremonyId: prompted.ceremonyId,
      response: prompted.response,
      name: parsed.data,
    });
  };

  return (
    <AuthLayout
      title={t('auth:enrolment.choose.nameTitle')}
      subtitle={t('auth:enrolment.choose.nameBody')}
      width={520}
      footer={
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Link component="button" type="button" variant="caption" onClick={onSignOut}>
            {t('auth:enrolment.step1.signOut')}
          </Link>
        </Box>
      }
    >
      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('auth:enrolment.choose.stepPasskey')}
        </Typography>
        <AlertBanner tone="success">{t('auth:enrolment.choose.added')}</AlertBanner>
        {failure ? <AlertBanner tone="danger">{failure}</AlertBanner> : null}
        <Field
          id={fieldId}
          label={t('auth:enrolment.choose.nameLabel')}
          hint={hint}
          error={invalid ?? undefined}
        >
          <OutlinedInput
            id={fieldId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            error={invalid !== null}
            fullWidth
            slotProps={{
              input: {
                maxLength: PASSKEY_NAME_MAX_LENGTH,
                'aria-describedby': fieldDescribedBy(fieldId, {
                  hint,
                  error: invalid ?? undefined,
                }),
              },
            }}
          />
        </Field>
        <Button type="submit" variant="contained" loading={pending}>
          {t('auth:enrolment.choose.submit')}
        </Button>
      </Box>
    </AuthLayout>
  );
}
