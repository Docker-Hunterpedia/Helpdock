import { OAUTH_PROVIDERS, type OauthProvider } from '@helpdock/schemas';
import { Box, Button } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { PROVIDER_NAME_KEYS } from '../auth/provider-names.js';
import { useAuthApi } from '../auth/session.tsx';
import { ProviderMark } from '../ui/provider-marks.tsx';

/** The providers the install has configured, in the sign-in page's order. */
export function useConfiguredProviders(): readonly OauthProvider[] {
  const api = useAuthApi();
  const methods = useQuery({ queryKey: ['auth', 'methods'], queryFn: () => api.authMethods() });
  return OAUTH_PROVIDERS.filter((provider) => methods.data?.oauth[provider] === true);
}

/**
 * The provider buttons of `Admin/AcceptInvite-Providers`: one equal column
 * each, as on the sign-in page. Choosing one starts accepting the invitation
 * with that provider instead of a password.
 */
export function InviteProviderButtons({
  providers,
  busy,
  onChoose,
}: {
  readonly providers: readonly OauthProvider[];
  readonly busy: boolean;
  onChoose(provider: OauthProvider): void;
}): ReactNode {
  const t = useT();

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(${providers.length}, minmax(0, 1fr))`,
        gap: 3,
      }}
    >
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outlined"
          color="secondary"
          disabled={busy}
          startIcon={<ProviderMark name={provider} />}
          onClick={() => {
            onChoose(provider);
          }}
        >
          {t(PROVIDER_NAME_KEYS[provider])}
        </Button>
      ))}
    </Box>
  );
}
