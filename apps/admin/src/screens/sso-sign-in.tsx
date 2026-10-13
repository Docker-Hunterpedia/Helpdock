import { Box, Button, OutlinedInput, Typography } from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useT } from '../app/i18n.js';
import { useAuthApi } from '../auth/session.tsx';
import { AlertBanner } from '../ui/alert-banner.tsx';
import { Field, fieldDescribedBy } from '../ui/field.tsx';
import { validateEmail } from './sign-in-form.js';

export function SsoButtons({
  connections,
  returnTo,
}: {
  connections: readonly { id: string; name: string }[];
  returnTo: string;
}) {
  const t = useT();
  const api = useAuthApi();
  return connections.length ? (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {connections.map((connection) => (
        <Button
          key={connection.id}
          component="a"
          href={api.ssoStartUrl(connection.id, returnTo)}
          variant="outlined"
          color="secondary"
          startIcon={<KeyRound size={16} aria-hidden="true" />}
        >
          {t('auth:sso.continueWith', { provider: connection.name })}
        </Button>
      ))}
    </Box>
  ) : null;
}

/** The email-first state on Admin/Login-SSO and its Arabic artboard. */
export function SsoEmailForm({ returnTo }: { returnTo: string }) {
  const t = useT();
  const api = useAuthApi();
  const [email, setEmail] = useState('');
  const [invalid, setInvalid] = useState<string>();
  const discovery = useMutation({
    mutationFn: () => api.discoverSso(email.trim()),
    onSuccess: ({ connections }) => {
      if (connections.length === 1 && connections[0])
        window.location.assign(api.ssoStartUrl(connections[0].id, returnTo));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = validateEmail(email);
    setInvalid(
      issue
        ? t(issue === 'required' ? 'auth:signIn.emailRequired' : 'auth:signIn.emailInvalid')
        : undefined,
    );
    if (!issue) discovery.mutate();
  };
  return (
    <Box
      component="form"
      onSubmit={submit}
      noValidate
      sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}
    >
      <Field id="sso-email" label={t('auth:sso.workEmail')} error={invalid}>
        <OutlinedInput
          id="sso-email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            discovery.reset();
          }}
          error={Boolean(invalid)}
          fullWidth
          slotProps={{
            input: {
              dir: 'ltr',
              autoComplete: 'username',
              'aria-describedby': fieldDescribedBy('sso-email', { error: invalid }),
            },
          }}
        />
      </Field>
      <Button type="submit" variant="contained" loading={discovery.isPending}>
        {t('auth:sso.continue')}
      </Button>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('auth:sso.redirectHint')}
      </Typography>
      <AlertBanner tone="info">{t('auth:sso.required')}</AlertBanner>
      {discovery.isError ? <AlertBanner tone="danger">{t('auth:unavailable')}</AlertBanner> : null}
      {discovery.data?.connections.length === 0 ? (
        <AlertBanner tone="danger">{t('auth:sso.noConnection')}</AlertBanner>
      ) : null}
      <SsoButtons connections={discovery.data?.connections ?? []} returnTo={returnTo} />
    </Box>
  );
}

export function InviteSsoButtons({ email }: { email: string }) {
  const api = useAuthApi();
  const connections = useQuery({
    queryKey: ['auth', 'sso', 'discover', email],
    queryFn: () => api.discoverSso(email),
  });
  return <SsoButtons connections={connections.data?.connections ?? []} returnTo="/tickets" />;
}
